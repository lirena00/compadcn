import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath } from "../project/files.js";
import { CliError } from "../core/errors.js";
import { parseCollection, type Collection } from "./model.js";

export async function readCollectionBytes(path: string, limit = 1024 * 1024): Promise<Buffer> {
  const before = await lstat(resolve(path)).catch(() => { throw new CliError("COLLECTION_UNREADABLE", "Cannot read the requested collection or legacy preset file."); });
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new CliError("COLLECTION_INPUT_INVALID", "Input must be an ordinary file within its size limit.");
  const handle = await open(resolve(path), "r").catch(() => { throw new CliError("COLLECTION_UNREADABLE", "Cannot read the requested collection or legacy preset file."); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || stat.ino !== before.ino || stat.dev !== before.dev) throw new CliError("COLLECTION_INPUT_INVALID", "Input must remain an ordinary file within its size limit.");
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    const current = await handle.stat();
    if (offset !== stat.size || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new CliError("COLLECTION_INPUT_CHANGED", "Input changed while it was being read.");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function readCollection(path: string): Promise<Collection> { return parseCollection((await readCollectionBytes(path)).toString("utf8")); }

export async function assertNewPath(path: string): Promise<string> {
  const absolute = resolve(path);
  if (/[\p{Cc}\p{Cf}]/u.test(absolute) || canonicalPath(absolute) !== absolute) throw new CliError("COLLECTION_OUTPUT_INVALID", "Choose an output path without control characters or symbolic links.");
  try { await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute; throw error; }
  throw new CliError("COLLECTION_OUTPUT_EXISTS", "Collection outputs are never overwritten; choose a new file or directory.");
}

export async function writeNewFile(path: string, bytes: string | Buffer): Promise<void> {
  if (canonicalPath(path) !== resolve(path)) throw new CliError("COLLECTION_OUTPUT_INVALID", "Output directories changed or traverse symbolic links.");
  const handle = await open(path, "wx", 0o600).catch(() => { throw new CliError("COLLECTION_WRITE_FAILED", "Could not exclusively create the requested output. Existing files were preserved."); });
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function writeCollection(input: unknown, output: string): Promise<string> {
  const collection = parseCollection(input), path = await assertNewPath(output);
  if (!path.endsWith(".json") || /^(?:package|components|(?:tsconfig|jsconfig)(?:\.[^.]+)*|knip|biome|\.eslintrc)\.json$|\.config\.json$/i.test(basename(path))) throw new CliError("COLLECTION_OUTPUT_INVALID", "Choose a collection JSON filename instead of project configuration.");
  await mkdir(dirname(path), { recursive: true });
  await assertNewPath(path); await writeNewFile(path, JSON.stringify(collection, null, 2) + "\n");
  return path;
}

export interface CollectionList { directory: string; entries: { path: string; name?: string; items?: number; error?: string }[]; complete: boolean }
export async function listCollections(directory: string): Promise<CollectionList> {
  const root = resolve(directory), files = await readdir(root, { withFileTypes: true }).catch(() => { throw new CliError("COLLECTION_DIRECTORY_UNREADABLE", "Choose an existing directory of collection JSON files."); });
  const candidates = files.filter(file => file.name.endsWith(".json") && !file.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length > 1000) throw new CliError("COLLECTION_LIMIT", "List at most 1000 collection files in one directory.");
  const entries: CollectionList["entries"] = [];
  for (const file of candidates) {
    const path = join(root, file.name);
    try { const collection = await readCollection(path); entries.push({ path, name: collection.name, items: collection.items.length }); }
    catch (error) { entries.push({ path, error: error instanceof CliError ? error.code : "COLLECTION_UNREADABLE" }); }
  }
  return { directory: root, entries, complete: entries.every(entry => !entry.error) };
}
