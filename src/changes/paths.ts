import { isAbsolute, relative, resolve } from "node:path";
import { CliError } from "../core/errors.js";
import { canonicalPath, isWithin } from "../project/files.js";

export const ignoredDirectories = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", ".cache", ".shadcn-plus"]);
export const ignoredInputFile = (name: string): boolean => name.endsWith(".tsbuildinfo") || name === ".eslintcache" || name === ".stylelintcache";

export function portablePath(value: string, allowRoot = false): boolean {
  return (allowRoot && value === ".") || (!!value && !/[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith("/") && value.split("/").every((part) => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
}

export function localPath(root: string, path: string): string {
  if (!isWithin(root, path)) throw new CliError("PLAN_PATH_OUTSIDE_SCOPE", "A cleanup input leaves the analyzed workspace.");
  const value = relative(root, path).replaceAll("\\", "/") || ".";
  if (!portablePath(value, true)) throw new CliError("PLAN_PATH_UNSUPPORTED", "Cleanup paths must be portable relative paths without control characters.");
  return value;
}

export function resolveLocal(root: string, path: string): string {
  if (!portablePath(path, true) || isAbsolute(path)) throw new CliError("PLAN_PATH_INVALID", "A cleanup path is not a bounded relative path.");
  const result = resolve(root, path);
  if (!isWithin(root, result) || !isWithin(root, canonicalPath(result))) throw new CliError("PLAN_PATH_OUTSIDE_SCOPE", "A cleanup path resolves outside its workspace.");
  return result;
}
