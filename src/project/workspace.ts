import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { globSync } from "tinyglobby";
import { parseDocument } from "yaml";
import { CliError } from "../core/errors.js";
import { ancestors, canonicalPath, isObject, isWithin, readObject } from "./files.js";
import type { Workspace } from "./types.js";

function workspacePatterns(root: string): { configPath: string; patterns: string[] } | null {
  const yamlPath = join(root, "pnpm-workspace.yaml");
  const manifestPath = join(root, "package.json");
  let patterns: unknown;
  let configPath: string;
  if (existsSync(yamlPath)) {
    configPath = yamlPath;
    try {
      const doc = parseDocument(readFileSync(yamlPath, "utf8"));
      if (doc.errors.length) throw new Error("Invalid YAML");
      const data: unknown = doc.toJS({ maxAliasCount: 100 }) ?? {};
      if (!isObject(data)) throw new Error("Expected an object");
      patterns = data.packages ?? [];
    } catch {
      throw new CliError("WORKSPACE_CONFIG_INVALID", `Cannot read workspace packages from ${yamlPath}.`);
    }
  } else if (existsSync(manifestPath)) {
    const manifest = readObject(manifestPath, "PACKAGE_JSON_INVALID");
    if (manifest.workspaces === undefined) return null;
    configPath = manifestPath;
    patterns = isObject(manifest.workspaces) ? manifest.workspaces.packages : manifest.workspaces;
  } else {
    return null;
  }
  if (!Array.isArray(patterns) || !patterns.every((item) => typeof item === "string" && item.trim())) {
    throw new CliError("WORKSPACE_CONFIG_INVALID", `Workspace packages must be an array of nonempty patterns in ${configPath}.`);
  }
  // External workspaces need an explicit scope model before they can be analysed.
  for (const pattern of patterns as string[]) {
    const positive = pattern.replace(/^!/, "");
    if (isAbsolute(positive) || positive.includes("\\") || positive.split("/").includes("..")) {
      throw new CliError("WORKSPACE_SCOPE_UNSUPPORTED", `Workspace patterns must stay within ${root}.`);
    }
  }
  return { configPath, patterns: patterns as string[] };
}

export function findWorkspace(projectRoot: string): Workspace | null {
  for (const root of ancestors(projectRoot)) {
    const definition = workspacePatterns(root);
    if (!definition) continue;
    const paths = definition.patterns.length ? globSync(
      definition.patterns.map((pattern) => `${pattern.replace(/\/+$/, "")}/package.json`),
      {
        cwd: root, absolute: true, expandDirectories: false, followSymbolicLinks: false,
        ignore: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/dist/**", "**/build/**"],
      }
    ) : [];
    const roots = new Set([root, ...paths.map((path) => canonicalPath(resolve(path, "..")))]);
    if (!roots.has(projectRoot)) continue;
    const packages = [...roots].sort().map((directory) => {
      if (!isWithin(root, directory)) {
        throw new CliError("WORKSPACE_SCOPE_UNSUPPORTED", `A workspace package resolves outside ${root}.`);
      }
      const path = join(directory, "package.json");
      const manifest = existsSync(path) ? readObject(path, "PACKAGE_JSON_INVALID") : {};
      return { root: directory, ...(typeof manifest.name === "string" ? { name: manifest.name } : {}) };
    });
    const names = packages.flatMap((pkg) => pkg.name ? [pkg.name] : []);
    if (new Set(names).size !== names.length) {
      throw new CliError("WORKSPACE_PACKAGE_AMBIGUOUS", `Duplicate package names in ${root}.`);
    }
    return { root, configPath: definition.configPath, packages };
  }
  return null;
}
