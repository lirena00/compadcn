import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createPathsMatcher, parseTsconfig } from "get-tsconfig";
import { parse, type ParseError } from "jsonc-parser";
import { CliError } from "../core/errors.js";
import { ancestors, canonicalPath, isObject, isWithin, readObject } from "./files.js";
import type { Diagnostic, ResolvedAlias, WorkspacePackage } from "./types.js";

interface CompilerConfig {
  path: string;
  config: ReturnType<typeof parseTsconfig>;
  match: ReturnType<typeof createPathsMatcher>;
}

export function loadCompilerConfigs(root: string, boundary: string, diagnostics: Diagnostic[]): CompilerConfig[] {
  const configs: CompilerConfig[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (input: string): void => {
    const path = canonicalPath(input);
    if (visiting.has(path)) {
      diagnostics.push({ code: "CONFIG_REFERENCE_CYCLE", severity: "error", message: "Compiler configuration references contain a cycle.", path });
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    if (!isWithin(boundary, path)) {
      diagnostics.push({ code: "CONFIG_REFERENCE_OUTSIDE_WORKSPACE", severity: "error", message: "Compiler references outside the workspace are unsupported.", path });
      return;
    }
    visiting.add(path);
    try {
      const errors: ParseError[] = [];
      const raw: unknown = parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
      if (errors.length || !isObject(raw)) throw new Error("Invalid JSONC");
      const config = parseTsconfig(path);
      if (!isObject(config) || (config.compilerOptions !== undefined && !isObject(config.compilerOptions))) throw new Error("Invalid config");
      const paths = config.compilerOptions?.paths;
      if (paths !== undefined && (!isObject(paths) || !Object.values(paths).every(
        (value) => Array.isArray(value) && value.length && value.every((item) => typeof item === "string")
      ))) throw new Error("Invalid paths");
      configs.push({ path, config, match: createPathsMatcher({ path, config }) });
      if (config.references !== undefined) {
        if (!Array.isArray(config.references)) throw new Error("Invalid references");
        for (const reference of config.references) {
          if (!isObject(reference) || typeof reference.path !== "string") throw new Error("Invalid reference");
          let target = resolve(dirname(path), reference.path);
          if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "tsconfig.json");
          visit(target);
        }
      }
    } catch {
      diagnostics.push({ code: "COMPILER_CONFIG_INVALID", severity: "error", message: "Cannot parse compiler configuration, its extends chain, or path mappings.", path });
    }
    visiting.delete(path);
  };

  for (const directory of ancestors(root)) {
    const path = ["tsconfig.json", "jsconfig.json"].map((name) => join(directory, name)).find(existsSync);
    if (path) { visit(path); break; }
    if (directory === boundary) break;
  }
  return configs;
}

// Match explicit mappings only: a compiler baseUrl alone is not evidence for @/ui.
function mappingKey(map: Record<string, unknown>, specifier: string): string | undefined {
  if (Object.hasOwn(map, specifier)) return specifier;
  return Object.keys(map).filter((key) => {
    const parts = key.split("*");
    return parts.length === 2 && specifier.startsWith(parts[0]!) && specifier.endsWith(parts[1]!) &&
      specifier.length >= parts[0]!.length + parts[1]!.length;
  }).sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
}

const marker = "__shadcn_plus_directory__";

function mappedTargets(map: Record<string, unknown>, specifier: string): string[] {
  const key = mappingKey(map, specifier);
  if (!key) return [];
  const values = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(values);
    // Distinct conditional destinations stay ambiguous until supported explicitly.
    if (isObject(value)) return Object.values(value).flatMap(values);
    return [];
  };
  const star = key.indexOf("*");
  const wildcard = star < 0 ? "" : specifier.slice(star, specifier.length - (key.length - star - 1));
  return values(map[key]).map((value) => {
    const target = star < 0 ? value : value.replaceAll("*", wildcard);
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch {
      throw new CliError("ALIAS_TARGET_UNSUPPORTED", "Package mappings contain invalid URL encoding.");
    }
    if (!target.startsWith("./") || decoded.includes("\\") || decoded.split("/").some((part) => part === ".." || part === "node_modules")) {
      throw new CliError("ALIAS_TARGET_UNSUPPORTED", "Package mappings must point inside their owning package without traversal or node_modules segments.");
    }
    if (target.includes("?") || target.includes("#")) {
      throw new CliError("ALIAS_TARGET_UNSUPPORTED", "Package mappings with URL queries or fragments are unsupported.");
    }
    return decoded;
  });
}

function directoryTargets(specifier: string, directory: boolean, match: (value: string) => string[], preferExact = false): string[] {
  if (directory && !preferExact) {
    const targets = match(`${specifier.replace(/\/$/, "")}/${marker}`);
    if (targets.length) {
      // A mapping such as ./components/*.tsx routes directory aliases too.
      return targets.map((target) => {
        if (!new RegExp(`[/\\\\]${marker}(?:\\.[a-zA-Z0-9.]+)?$`).test(target)) {
          throw new CliError("ALIAS_TARGET_UNSUPPORTED", "Directory mappings must preserve the wildcard path.");
        }
        const parent = dirname(target);
        return parent === "." ? "./" : parent;
      });
    }
  }
  const targets = match(specifier);
  if (directory && targets.some((target) => /\.(?:[cm]?[jt]sx?)$/.test(target))) {
    throw new CliError("ALIAS_TARGET_UNSUPPORTED", "A directory alias points to a source file; expose its directory with a wildcard mapping.");
  }
  return targets;
}

interface AliasOptions {
  specifier: string;
  directory: boolean;
  root: string;
  boundary: string;
  manifest: Record<string, unknown>;
  configs: CompilerConfig[];
  packages: WorkspacePackage[];
}

export function resolveAlias(options: AliasOptions): ResolvedAlias {
  const { specifier, directory, root, boundary, manifest, configs, packages } = options;
  let candidates: { path: string; source: ResolvedAlias["source"]; configPath: string }[] = [];
  for (const compiler of configs) {
    const paths = compiler.config.compilerOptions?.paths;
    if (!paths) continue;
    const targets = directoryTargets(specifier, directory, (value) =>
      mappingKey(paths, value) ? compiler.match?.(value) ?? [] : [], Object.hasOwn(paths, specifier)
    );
    candidates.push(...targets.map((path) => ({ path, source: "tsconfig" as const, configPath: compiler.path })));
  }
  if (!candidates.length && (specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier))) {
    candidates = [{ path: resolve(root, specifier), source: "relative", configPath: join(root, "components.json") }];
  }
  if (!candidates.length && specifier.startsWith("#") && isObject(manifest.imports)) {
    candidates = directoryTargets(specifier, directory, (value) => mappedTargets(manifest.imports as Record<string, unknown>, value))
      .map((path) => {
        if (!path.startsWith("./")) throw new CliError("ALIAS_TARGET_UNSUPPORTED", "Only local package import targets are supported.");
        return { path: resolve(root, path), source: "package-imports", configPath: join(root, "package.json") };
      });
  }
  if (!candidates.length && !specifier.startsWith("#")) {
    const pkg = packages.find(({ name }) => name && (specifier === name || specifier.startsWith(`${name}/`)));
    if (pkg?.name) {
      const configPath = join(pkg.root, "package.json");
      const targetManifest = readObject(configPath, "PACKAGE_JSON_INVALID");
      const exports = targetManifest.exports;
      const map = isObject(exports) && Object.keys(exports).some((key) => key.startsWith(".")) ? exports : { ".": exports };
      const subpath = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
      candidates = directoryTargets(subpath, directory, (value) => mappedTargets(map, value)).map((path) => {
        if (!path.startsWith("./")) throw new CliError("ALIAS_TARGET_UNSUPPORTED", "Workspace exports must point to local files.");
        return { path: resolve(pkg.root, path), source: "workspace-exports", configPath };
      });
    }
  }
  const normalized = candidates.map((candidate) => {
    let path = candidate.path;
    if (!directory && !extname(path) && !existsSync(path)) {
      path = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => path + extension).find(existsSync) ?? path;
    }
    return { ...candidate, path: canonicalPath(path) };
  });
  const targets = new Set(normalized.map(({ path }) => path));
  if (targets.size > 1) throw new CliError("ALIAS_AMBIGUOUS", "Alias maps to multiple destinations across compiler configurations or package conditions.");
  const target = normalized[0];
  if (!target) throw new CliError("ALIAS_UNRESOLVED", "No explicit path mapping, package import, or workspace export resolves this alias.");
  if (!isWithin(boundary, target.path)) throw new CliError("ALIAS_OUTSIDE_WORKSPACE", "Alias resolves outside the selected project or workspace.");
  const exists = existsSync(target.path);
  if (directory && exists && !statSync(target.path).isDirectory()) throw new CliError("ALIAS_TARGET_UNSUPPORTED", "A directory alias resolves to a file.");
  return { specifier, ...target, exists };
}
