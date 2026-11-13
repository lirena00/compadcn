import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON, digest } from "../core/hash.js";
import { CliError } from "../core/errors.js";
import { canonicalPath, isWithin } from "../project/files.js";
import type { Diagnostic } from "../project/types.js";
import { ignoredDirectories, localPath, portablePath } from "./paths.js";
import type { ScopeFile, ScopeSnapshot } from "./schema.js";

export interface SnapshotOptions { signal?: AbortSignal; excludedArtifacts?: string[]; maxInputFiles?: number; maxInputBytes?: number }

export function validateSnapshotOptions(options: SnapshotOptions): void {
  if (!Number.isInteger(options.maxInputFiles ?? 50000) || (options.maxInputFiles ?? 50000) < 1 || (options.maxInputFiles ?? 50000) > 100000 ||
    !Number.isInteger(options.maxInputBytes ?? 268435456) || (options.maxInputBytes ?? 268435456) < 1 || (options.maxInputBytes ?? 268435456) > 1073741824 ||
    options.excludedArtifacts?.some((value) => !portablePath(value) || !value.endsWith(".json"))) throw new CliError("INVALID_OPTIONS", "Snapshot limits or artifact exclusions are invalid.");
}

export async function takeScopeSnapshot(root: string, options: SnapshotOptions = {}): Promise<ScopeSnapshot> {
  validateSnapshotOptions(options);
  root = canonicalPath(root);
  const limits = { files: options.maxInputFiles ?? 50000, bytes: options.maxInputBytes ?? 268435456 };
  const excludedArtifacts = [...new Set(options.excludedArtifacts ?? [])].sort();
  const files: ScopeFile[] = [], diagnostics: Diagnostic[] = [];
  const pending = [root];
  let bytes = 0, stopped = false;
  const fail = (code: string, message: string, path?: string) => diagnostics.push({ code, message, severity: "error", ...(path ? { path } : {}) });
  while (pending.length && !stopped) {
    if (options.signal?.aborted) { fail("PLAN_CANCELLED", "Input snapshot was cancelled."); break; }
    const directory = pending.pop()!;
    try {
      if (!isWithin(root, canonicalPath(directory))) throw new Error("Outside scope");
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ignoredDirectories.has(entry.name)) continue;
        const absolute = join(directory, entry.name), path = localPath(root, absolute);
        if (excludedArtifacts.includes(path)) continue;
        if (entry.isDirectory()) { pending.push(absolute); continue; }
        if (files.length >= limits.files) { fail("PLAN_INPUT_LIMIT", "Input snapshot exceeds its file-count limit."); stopped = true; break; }
        if (options.signal?.aborted) { fail("PLAN_CANCELLED", "Input snapshot was cancelled."); stopped = true; break; }
        const before = await lstat(absolute);
        if (before.isSymbolicLink()) {
          const target = await readlink(absolute);
          files.push({ path, kind: "link", sha256: digest(target), bytes: Buffer.byteLength(target), mode: before.mode & 0o777, links: before.nlink });
          fail("PLAN_LINK_UNSUPPORTED", "Cleanup requires a scope without source or configuration symlinks; dependency/generated directories are excluded.", path);
          continue;
        }
        if (!before.isFile() || canonicalPath(absolute) !== absolute) { fail("PLAN_INPUT_UNSUPPORTED", "Input is not an ordinary in-scope file.", path); continue; }
        const hash = createHash("sha256"); let length = 0;
        for await (const chunk of createReadStream(absolute, { signal: options.signal })) {
          length += chunk.length;
          if (bytes + length > limits.bytes) { stopped = true; throw new CliError("PLAN_INPUT_LIMIT", "Input snapshot exceeds its byte limit."); }
          hash.update(chunk);
        }
        const after = await lstat(absolute);
        if (after.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== after.size || canonicalPath(absolute) !== absolute) {
          fail("PLAN_INPUT_CHANGED", "Input changed while its content was being fingerprinted.", path); continue;
        }
        bytes += length;
        files.push({ path, kind: "file", sha256: hash.digest("hex"), bytes: length, mode: after.mode & 0o777, links: after.nlink });
      }
    } catch (error) { fail(error instanceof CliError ? error.code : "PLAN_INPUT_UNREADABLE", error instanceof CliError ? error.message : "Could not read the complete input scope.", localPath(root, directory)); }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const body = { root, files, excludedArtifacts, limits };
  return { snapshotVersion: 1, ...body, fingerprint: digest(canonicalJSON(body)), diagnostics, complete: !diagnostics.length };
}

export function snapshotChanges(before: ScopeSnapshot, after: ScopeSnapshot): { code: string; path?: string }[] {
  const changes: { code: string; path?: string }[] = [];
  if (before.root !== after.root) changes.push({ code: "PLAN_ROOT_CHANGED" });
  if (!before.complete || !after.complete) changes.push({ code: "PLAN_INPUTS_INCOMPLETE" });
  const old = new Map(before.files.map((file) => [file.path, file])), current = new Map(after.files.map((file) => [file.path, file]));
  for (const [path, file] of old) {
    const value = current.get(path);
    if (!value) changes.push({ code: "PLAN_INPUT_REMOVED", path });
    else if (canonicalJSON(file) !== canonicalJSON(value)) changes.push({ code: "PLAN_INPUT_CHANGED", path });
  }
  for (const path of current.keys()) if (!old.has(path)) changes.push({ code: "PLAN_INPUT_ADDED", path });
  return changes.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.code.localeCompare(b.code));
}
