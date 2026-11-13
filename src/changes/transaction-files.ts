import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalPath, isWithin } from "../project/files.js";
import { digest } from "../core/hash.js";
import { CliError } from "../core/errors.js";
import { resolveLocal } from "./paths.js";
import type { CleanupOperation } from "./schema.js";

// Synchronous, bounded critical sections avoid yielding between a final path/
// identity check and a mutation. Node has no portable compare-and-unlink API;
// these checks do not isolate the tree from arbitrary external writers.
export function ordinaryPath(root: string, relative: string): string {
  const path = resolveLocal(root, relative);
  if (canonicalPath(path) !== path) throw new CliError("CLEANUP_LINK_UNSUPPORTED", "Cleanup paths must not traverse symbolic links.");
  return path;
}

export function stateDirectory(root: string): string {
  const path = ordinaryPath(root, ".shadcn-plus");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || canonicalPath(path) !== path) throw new CliError("CLEANUP_STATE_INVALID", "Cleanup state must be an ordinary directory inside the workspace.");
  return path;
}

export function writeExclusive(path: string, bytes: string | Buffer, mode = 0o600): void {
  const fd = openSync(path, "wx", mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

export function readOrdinary(path: string, maxBytes: number): { bytes: Buffer; stat: Stats } {
  if (canonicalPath(path) !== resolve(path)) throw new CliError("CLEANUP_LINK_UNSUPPORTED", "Refusing a linked cleanup file.");
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new CliError("CLEANUP_FILE_UNSUPPORTED", "Cleanup requires bounded ordinary files with one hard link.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1 || stat.size > maxBytes) throw new CliError("CLEANUP_FILE_CHANGED", "File identity changed while opening it.");
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const size = readSync(fd, bytes, offset, bytes.length - offset, null); if (!size) break; offset += size; }
    const after = fstatSync(fd), current = lstatSync(path);
    if (offset !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink() || canonicalPath(path) !== resolve(path)) throw new CliError("CLEANUP_FILE_CHANGED", "File changed while reading its bytes.");
    return { bytes, stat };
  } finally { closeSync(fd); }
}

export function readTarget(root: string, operation: CleanupOperation) {
  const path = ordinaryPath(root, operation.path), value = readOrdinary(path, 2 * 1024 * 1024);
  if (digest(value.bytes) !== operation.before.sha256 || value.bytes.length !== operation.before.bytes || (value.stat.mode & 0o777) !== operation.before.mode) throw new CliError("CLEANUP_FILE_CHANGED", "A target no longer matches its exact planned bytes and permissions.", { path: operation.path });
  return { path, ...value };
}

export function removeTarget(root: string, operation: CleanupOperation): void {
  const value = readTarget(root, operation);
  // No asynchronous work or callbacks between the final check and unlink.
  unlinkSync(value.path);
}

export function restoreExclusive(root: string, operation: CleanupOperation, bytes: Buffer, times: { atimeMs: number; mtimeMs: number }): "created" | "already-original" {
  const target = ordinaryPath(root, operation.path);
  try {
    lstatSync(target);
    readTarget(root, operation);
    return "already-original";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CliError("RESTORE_CONFLICT", "The target exists with different bytes, permissions, or a link; it was preserved.", { path: operation.path });
  }
  const parent = dirname(target);
  if (!isWithin(root, parent) || canonicalPath(parent) !== parent || !lstatSync(parent).isDirectory()) throw new CliError("RESTORE_PARENT_CHANGED", "The original parent directory is missing or linked.", { path: operation.path });
  const temporary = join(parent, `.shadcn-plus-restore-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes); fchmodSync(fd, operation.before.mode);
    futimesSync(fd, times.atimeMs / 1000, times.mtimeMs / 1000); fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    ordinaryPath(root, operation.path);
    // link is exclusive: a concurrently recreated target is never overwritten.
    linkSync(temporary, target);
  } finally { unlinkSync(temporary); }
  return "created";
}

export function readStateFile(path: string, limit: number): Buffer { return readOrdinary(path, limit).bytes; }
