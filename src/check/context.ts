import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalJSON, digest } from "../core/hash.js";
import { discoverProject } from "../project/discover.js";
import { loadCompilerConfigs } from "../project/aliases.js";
import { isWithin, readObject } from "../project/files.js";
import type { Diagnostic, ProjectContext } from "../project/types.js";
import { localPath } from "../changes/paths.js";
import type { AuditOptions } from "../audit/build.js";

// Bind baseline waivers to configuration and entry policy, without binding
// unrelated source files or the absolute checkout location into their identity.
export function checkContext(project: ProjectContext, options: AuditOptions) {
  const root = project.workspace?.root ?? project.projectRoot;
  const paths = [...new Set([root, project.projectRoot, ...(project.workspace?.packages.map(pkg => pkg.root) ?? [])])].sort();
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
    if (typeof value === "string" && isAbsolute(value)) {
      if (isWithin(root, value)) return `[workspace]/${localPath(root, value)}`;
      const dependency = value.replaceAll("\\", "/").lastIndexOf("/node_modules/");
      if (dependency !== -1) return `[dependency]/${value.replaceAll("\\", "/").slice(dependency + 14)}`;
    }
    return value;
  };
  const diagnostics: Diagnostic[] = [];
  const scopes = paths.map(path => {
    const context = path === project.projectRoot ? project : discoverProject({ cwd: path, env: options.env });
    const manifest = readObject(context.packageJsonPath, "PACKAGE_JSON_INVALID");
    const metadata = Object.fromEntries(["name", "type", "main", "module", "types", "exports", "imports", "bin", "registries", "workspaces"].filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
    const configs = loadCompilerConfigs(path, root, diagnostics).map(config => ({ path: localPath(root, config.path), config: normalize(config.config) }));
    const files = readdirSync(path).filter(name => /^(?:next|vite)\.config\./.test(name) || name === "components.json").sort().map(name => ({ path: localPath(root, join(path, name)), hash: digest(readFileSync(join(path, name))) }));
    return { scope: localPath(root, path), framework: context.framework, metadata, configs, files };
  });
  const workspace = project.workspace?.configPath;
  const body = { contextVersion: 1, scopes, ...(workspace && existsSync(workspace) && !workspace.endsWith("package.json") ? { workspaceHash: digest(readFileSync(workspace)) } : {}),
    entries: options.entries ?? [], devEntries: options.devEntries ?? [], maxItems: options.maxItems ?? 2000, maxFiles: options.maxFiles ?? 20000 };
  return { root, fingerprint: digest(canonicalJSON(body)), diagnostics };
}
