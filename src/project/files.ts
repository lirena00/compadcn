import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CliError } from "../core/errors.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readObject(path: string, code: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isObject(data)) return data;
  } catch {
    // Do not echo configuration contents, which can include registry credentials.
  }
  throw new CliError(code, `Expected a readable JSON object at ${path}.`);
}

export function isWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

// Resolve symlinks even when the final installation directory does not exist yet.
export function canonicalPath(path: string): string {
  let parent = resolve(path);
  const suffix: string[] = [];
  while (true) {
    let found = false;
    try {
      lstatSync(parent);
      found = true;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    // A dangling link is an unresolved target, not a missing in-scope directory.
    if (found) return join(realpathSync(parent), ...suffix);
    const next = dirname(parent);
    if (next === parent) return resolve(path);
    suffix.unshift(relative(next, parent));
    parent = next;
  }
}

export function* ancestors(start: string): Generator<string> {
  let directory = resolve(start);
  while (true) {
    yield directory;
    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) return;
    directory = parent;
  }
}

export function findProject(cwd: string): { cwd: string; root: string; manifest: Record<string, unknown> } {
  let start: string;
  try {
    start = realpathSync(resolve(cwd));
    if (!statSync(start).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new CliError("CWD_INVALID", `Project directory does not exist or is not readable: ${resolve(cwd)}.`);
  }
  for (const directory of ancestors(start)) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      return { cwd: start, root: directory, manifest: readObject(path, "PACKAGE_JSON_INVALID") };
    }
  }
  throw new CliError("PROJECT_NOT_FOUND", `No package.json found from ${start} up to the repository boundary.`);
}
