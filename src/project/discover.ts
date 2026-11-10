import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../core/errors.js";
import { getPackageManagerInfo } from "../utils/getUserPkgManager.js";
import { loadCompilerConfigs, resolveAlias } from "./aliases.js";
import { canonicalPath, findProject, isObject, isWithin, readObject } from "./files.js";
import { findWorkspace } from "./workspace.js";
import type { Diagnostic, ProjectContext } from "./types.js";

export interface DiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function discoverProject({ cwd = process.cwd(), env = process.env }: DiscoveryOptions = {}): ProjectContext {
  const project = findProject(cwd);
  const { root, manifest } = project;
  const diagnostics: Diagnostic[] = [];
  const context: ProjectContext = {
    cwd: project.cwd, projectRoot: root, packageJsonPath: join(root, "package.json"),
    ...(typeof manifest.name === "string" ? { packageName: manifest.name } : {}),
    framework: "unknown", sourceRoots: [], workspace: null, packageManager: null,
    compilerConfigs: [], components: null, diagnostics, ready: false,
  };
  const attempt = (operation: () => void, path: string): void => {
    try { operation(); } catch (error) {
      diagnostics.push({
        code: error instanceof CliError ? error.code : "PROJECT_READ_FAILED", severity: "error",
        message: error instanceof CliError ? error.message : "Cannot read project configuration.", path,
      });
    }
  };
  attempt(() => { context.workspace = findWorkspace(root); }, root);
  const boundary = context.workspace?.root ?? root;
  attempt(() => {
    context.packageManager = getPackageManagerInfo({ cwd: root, env, boundary });
    if (context.workspace && context.workspace.root !== root) {
      const workspaceManager = getPackageManagerInfo({ cwd: context.workspace.root, env, boundary });
      if (["packageManager", "lockfile", "workspace"].includes(workspaceManager.source) && workspaceManager.name !== context.packageManager.name) {
        throw new CliError("PACKAGE_MANAGER_CONFLICT", "Selected package and workspace root declare different package managers.");
      }
    }
  }, root);

  const dependencies = {
    ...(isObject(manifest.peerDependencies) ? manifest.peerDependencies : {}),
    ...(isObject(manifest.devDependencies) ? manifest.devDependencies : {}),
    ...(isObject(manifest.dependencies) ? manifest.dependencies : {}),
  };
  const has = (name: string): boolean => Object.hasOwn(dependencies, name);
  context.framework = has("next") ? "next" : has("react") && has("vite") ? "vite-react" : has("react") ? "react" : "unknown";
  if (context.framework === "unknown") diagnostics.push({ code: "FRAMEWORK_UNRECOGNIZED", severity: "warning", message: "No Next.js, Vite React, or React dependency was detected. Only configuration resolution is checked." });
  if (context.framework === "react") diagnostics.push({ code: "FRAMEWORK_GENERIC_REACT", severity: "warning", message: "React configuration is resolved; framework-specific entry and usage analysis is not checked." });
  attempt(() => {
    for (const name of ["src", "app", "pages", "components"]) {
      const path = join(root, name);
      if (!existsSync(path) || !statSync(path).isDirectory()) continue;
      const canonical = canonicalPath(path);
      if (!isWithin(boundary, canonical)) {
        throw new CliError("SOURCE_OUTSIDE_WORKSPACE", `Source directory resolves outside the selected project or workspace: ${path}.`);
      }
      if (!context.sourceRoots.includes(canonical)) context.sourceRoots.push(canonical);
    }
  }, root);
  const configs = loadCompilerConfigs(root, boundary, diagnostics);
  context.compilerConfigs = configs.map(({ path }) => path);
  const configPath = join(root, "components.json");
  attempt(() => {
    if (!existsSync(configPath)) {
      throw new CliError("CONFIG_NOT_FOUND", "components.json is missing in the selected package. Initialize shadcn there, or select a configured workspace with doctor --cwd <path>.");
    }
    const config = readObject(configPath, "CONFIG_INVALID");
    if (!isObject(config.aliases) || typeof config.aliases.ui !== "string" || !config.aliases.ui.trim() ||
      !Object.values(config.aliases).every((value) => typeof value === "string" && value.trim()) ||
      (config.tsx !== undefined && typeof config.tsx !== "boolean")) {
      throw new CliError("CONFIG_INVALID", "components.json must define nonempty string aliases including aliases.ui, and a boolean tsx when specified.");
    }
    const aliases = config.aliases as Record<string, string>;
    context.components = { path: configPath, tsx: config.tsx !== false, aliases, resolvedAliases: Object.create(null) as Record<string, never> };
    for (const [name, specifier] of Object.entries(aliases)) {
      attempt(() => {
        const target = resolveAlias({
          specifier, directory: name !== "utils", root, boundary, manifest, configs,
          packages: context.workspace?.packages ?? [{ root, ...(typeof manifest.name === "string" ? { name: manifest.name } : {}) }],
        });
        context.components!.resolvedAliases[name] = target;
        if (name === "ui" && !target.exists) diagnostics.push({ code: "UI_DIRECTORY_MISSING", severity: "warning", message: "The resolved UI directory does not exist yet; no components may be installed.", path: target.path });
      }, `${configPath}#aliases.${name}`);
    }
  }, configPath);
  context.ready = !diagnostics.some(({ severity }) => severity === "error");
  return context;
}
