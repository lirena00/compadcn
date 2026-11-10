import { existsSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { createFilesMatcher } from "get-tsconfig";
import { CliError } from "../core/errors.js";
import { canonicalPath, findProject, isObject, isWithin } from "../project/files.js";
import { loadCompilerConfigs, resolveAlias } from "../project/aliases.js";
import type { Diagnostic, ProjectContext } from "../project/types.js";
import { packageName } from "./registry.js";

export type Resolution = { kind: "file"; path: string; scope: string } | { kind: "package"; name: string; scope: string; manifestSpec?: string } | { kind: "builtin"; name: string; scope: string };

export class ReferenceResolver {
  readonly diagnostics: Diagnostic[] = [];
  #packages: NonNullable<ProjectContext["workspace"]>["packages"];
  #cache = new Map<string, {
    manifest: Record<string, unknown>;
    configs: ReturnType<typeof loadCompilerConfigs>;
    matchers: ReturnType<typeof createFilesMatcher>[];
  }>();

  constructor(readonly boundary: string, project: ProjectContext) {
    this.#packages = project.workspace?.packages ?? [{ root: project.projectRoot, ...(project.packageName ? { name: project.packageName } : {}) }];
  }

  #scope(path: string) {
    const project = findProject(dirname(path));
    let entry = this.#cache.get(project.root);
    if (!entry) {
      const configs = loadCompilerConfigs(project.root, this.boundary, this.diagnostics);
      entry = { manifest: project.manifest, configs, matchers: configs.map((config) => createFilesMatcher({ path: config.path, config: config.config })) };
      this.#cache.set(project.root, entry);
    }
    return { root: project.root, ...entry };
  }

  scopeOf(path: string): string { return this.#scope(path).root; }

  #file(candidate: string, from: string, options: ts.CompilerOptions): string | undefined {
    let path = ts.resolveModuleName(candidate, from, options, ts.sys).resolvedModule?.resolvedFileName;
    if (!path && extname(candidate) && existsSync(candidate) && statSync(candidate).isFile()) path = candidate;
    if (!path) return undefined;
    const target = canonicalPath(path);
    if (!isWithin(this.boundary, target)) throw new CliError("SOURCE_TARGET_OUTSIDE_SCOPE", "Local import resolves outside the selected project/workspace.");
    return target;
  }

  resolve(specifier: string, from: string): Resolution {
    const context = this.#scope(from);
    const scope = context.root;
    if (isBuiltin(specifier)) return { kind: "builtin", name: specifier.startsWith("node:") ? specifier : `node:${specifier}`, scope };
    if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) throw new CliError("SOURCE_ADDRESS_UNSUPPORTED", "URL and virtual-module imports require an explicit source adapter.");
    const applicable = context.configs.filter((_config, index) => !!context.matchers[index]?.(from));
    const configs = applicable.length ? applicable : context.configs;
    const optionsFor = (config: (typeof configs)[number] | undefined): ts.CompilerOptions => {
      const converted = ts.convertCompilerOptionsFromJson(config?.config.compilerOptions ?? {}, config ? dirname(config.path) : scope);
      if (converted.errors.length) throw new CliError("SOURCE_COMPILER_OPTIONS_INVALID", "Compiler options cannot be used for source resolution.");
      return { allowJs: true, resolveJsonModule: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, ...converted.options };
    };
    const defaults = optionsFor(configs[0]);
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const candidate = ts.resolveModuleName(specifier, from, defaults, ts.sys).resolvedModule?.resolvedFileName ?? resolve(dirname(from), specifier);
      const path = this.#file(candidate, from, defaults);
      if (!path) throw new CliError("SOURCE_IMPORT_UNRESOLVED", "Relative import does not resolve to a readable file.");
      return { kind: "file", path, scope };
    }
    const paths = new Set<string>();
    for (const config of configs) {
      for (const candidate of config.match?.(specifier) ?? []) {
        const path = this.#file(candidate, from, optionsFor(config));
        if (path) paths.add(path);
      }
    }
    if (paths.size > 1) throw new CliError("SOURCE_IMPORT_AMBIGUOUS", "Import resolves to different files across applicable compiler mappings.");
    if (paths.size) return { kind: "file", path: [...paths][0]!, scope };
    const localPackage = this.#packages.some(({ name }) => name && (specifier === name || specifier.startsWith(`${name}/`)));
    if (specifier.startsWith("#") || localPackage) {
      const alias = resolveAlias({ specifier, directory: false, root: scope, boundary: this.boundary, manifest: context.manifest, configs: [], packages: this.#packages });
      const path = this.#file(alias.path, from, defaults);
      if (!path) throw new CliError("SOURCE_IMPORT_UNRESOLVED", "Local package import/export target does not exist.");
      return { kind: "file", path, scope };
    }
    const resolved = ts.resolveModuleName(specifier, from, defaults, ts.sys).resolvedModule;
    if (resolved && !resolved.isExternalLibraryImport && isWithin(this.boundary, canonicalPath(resolved.resolvedFileName))) {
      return { kind: "file", path: canonicalPath(resolved.resolvedFileName), scope };
    }
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    if (!packageName(name)) throw new CliError("SOURCE_IMPORT_UNRESOLVED", "Import is neither a resolved local alias nor a supported package address.");
    const declarations = { ...(isObject(context.manifest.peerDependencies) ? context.manifest.peerDependencies : {}),
      ...(isObject(context.manifest.optionalDependencies) ? context.manifest.optionalDependencies : {}),
      ...(isObject(context.manifest.devDependencies) ? context.manifest.devDependencies : {}), ...(isObject(context.manifest.dependencies) ? context.manifest.dependencies : {}) };
    const specification = declarations[name];
    if (!resolved && typeof specification !== "string") throw new CliError("SOURCE_PACKAGE_UNRESOLVED", "Package import has neither an installed resolution nor a package.json declaration.");
    return { kind: "package", name, scope, ...(typeof specification === "string" ? { manifestSpec: specification } : {}) };
  }
}
