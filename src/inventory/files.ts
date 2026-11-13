import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { globSync } from "tinyglobby";
import { CliError } from "../core/errors.js";
import { canonicalPath, isWithin } from "../project/files.js";
import type { ProjectContext } from "../project/types.js";
import { digest } from "../registry/source.js";
import type { RemoteFile } from "../registry/types.js";
import type { ItemFile, LocalFile } from "./types.js";

const ignored = ["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", ".cache", ".shadcn-plus"].map((name) => `**/${name}/**`);

function directoryExists(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function checkedPath(root: string, path: string): string {
  if (!isWithin(root, resolve(path))) throw new CliError("FILE_TARGET_OUTSIDE_SCOPE", "Registry file target leaves its destination root.");
  const target = canonicalPath(path);
  if (!isWithin(canonicalPath(root), target)) throw new CliError("FILE_TARGET_OUTSIDE_SCOPE", "Registry file target resolves outside its destination root.");
  return target;
}

export function mapFile(file: RemoteFile, context: ProjectContext): ItemFile {
  const result: ItemFile = { registryPath: file.path, present: false, comparison: "unknown" };
  try {
    const aliases = context.components?.resolvedAliases ?? {};
    let path: string;
    if (file.target) {
      const target = file.target;
      if (isAbsolute(target) || target.includes("\\") || target.includes("\0")) throw new CliError("FILE_TARGET_UNSUPPORTED", "Registry targets must be portable relative paths.");
      const placeholder = /^@(ui|components|lib|hooks)\/(.+)$/.exec(target);
      if (placeholder) {
        const alias = aliases[placeholder[1]!];
        if (!alias) throw new CliError("FILE_ALIAS_UNRESOLVED", "Registry target requires an unresolved project alias.");
        path = checkedPath(alias.path, resolve(alias.path, placeholder[2]!));
      } else if (target.startsWith("~/")) {
        path = checkedPath(context.projectRoot, resolve(context.projectRoot, target.slice(2)));
      } else {
        if (target.startsWith("@") || target.startsWith("~")) throw new CliError("FILE_TARGET_UNSUPPORTED", "Registry target placeholder is unsupported.");
        let value = target.replace(/^src\//, "");
        if (file.type === "registry:page") {
          if (context.framework !== "next") throw new CliError("FILE_TARGET_UNSUPPORTED", "Page routing is currently resolved only for Next.js projects.");
          const app = ["app", "src/app"].some((name) => directoryExists(join(context.projectRoot, name)));
          const pages = ["pages", "src/pages"].some((name) => directoryExists(join(context.projectRoot, name)));
          if (!app && !pages) throw new CliError("FILE_TARGET_UNSUPPORTED", "Cannot infer the Next.js router for this page target.");
          if (!app) value = value.replace(/^app\//, "pages/").replace(/\/page(\.[jt]sx?)$/, "$1");
        }
        const base = context.sourceRoots.includes(join(context.projectRoot, "src")) ? join(context.projectRoot, "src") : context.projectRoot;
        path = checkedPath(base, resolve(base, value));
      }
      result.mapping = "explicit-target";
    } else {
      const role = file.type === "registry:ui" ? "ui" : file.type === "registry:lib" ? "lib" : file.type === "registry:hook" ? "hooks" :
        ["registry:component", "registry:block"].includes(file.type) ? "components" : undefined;
      const alias = role ? aliases[role] : undefined;
      if (!alias) throw new CliError("FILE_TARGET_UNSUPPORTED", "Registry file needs an explicit target or a resolved destination alias.");
      if (isAbsolute(file.path) || file.path.includes("\\") || file.path.split("/").some((part) => part === "..")) {
        throw new CliError("FILE_TARGET_UNSUPPORTED", "Registry source path is unsupported.");
      }
      const parts = file.path.replace(/^\/+|\/+$/g, "").split("/");
      const index = parts.indexOf(basename(alias.path));
      const nested = index < 0 ? parts.at(-1)! : parts.slice(index + 1).join("/");
      if (!nested) throw new CliError("FILE_TARGET_UNSUPPORTED", "Registry source path does not identify a file.");
      path = checkedPath(alias.path, resolve(alias.path, nested));
      result.mapping = "type-default";
    }
    if (context.components?.tsx === false) path = path.replace(/\.tsx$/, ".jsx").replace(/(?<!\.d)\.ts$/, ".js");
    path = checkedPath(context.workspace?.root ?? context.projectRoot, path);
    result.path = path;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new CliError("FILE_TARGET_NOT_FILE", "Registry file target exists but is not a regular file.");
      result.present = true;
      result.contentHash = digest(readFileSync(path));
      if (file.contentHash) result.comparison = result.contentHash === file.contentHash ? "exact-remote" : "different-or-transformed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    result.diagnostic = { code: error instanceof CliError ? error.code : "LOCAL_FILE_READ_FAILED", severity: "error",
      message: error instanceof CliError ? error.message : "Cannot resolve or read registry file target.", path: file.path };
  }
  return result;
}

export function scanLocalFiles(context: ProjectContext): LocalFile[] {
  const roots = Object.entries(context.components?.resolvedAliases ?? {}).filter(([name, alias]) => name !== "utils" && alias.exists).map(([, alias]) => alias.path);
  const files = new Map<string, LocalFile>();
  for (const root of [...new Set(roots)]) {
    for (const file of globSync("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, expandDirectories: false, ignore: ignored })) {
      if (!/\.(?:[cm]?[jt]sx?|css|scss|json|svg|mdx?)$/.test(file)) continue;
      const path = checkedPath(context.workspace?.root ?? context.projectRoot, join(root, file));
      if (files.has(path)) continue;
      if (files.size >= 20_000) throw new CliError("LOCAL_SCAN_LIMIT", "Local alias directories exceed the 20,000-file inventory limit.");
      files.set(path, { id: `local:${digest(path)}`, path, contentHash: digest(readFileSync(path)), ownerCandidates: [], origin: "unknown" });
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function localNames(files: LocalFile[], roots: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    names.add(basename(file.path).replace(/\.[^.]+$/, ""));
    for (const root of roots) if (isWithin(root, file.path)) {
      const parts = relative(root, file.path).split(/[\\/]/);
      names.add(parts.join("/").replace(/\.[^.]+$/, ""));
      for (let index = 0; index < parts.length - 1; index++) {
        names.add(parts[index]!);
        names.add(parts.slice(0, index + 1).join("/"));
      }
    }
  }
  return names;
}
