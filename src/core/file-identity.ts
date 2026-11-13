import type { Stats } from "node:fs";

// Older Windows libuv path-stat fast paths can report dev=0 while fstat
// reports the volume serial for the same inode. Treat only that missing
// Windows device value as unavailable. Known device mismatches still fail.
// Callers must also enforce ordinary files, bounded canonical paths, link
// counts, and unchanged bytes/metadata; inode equality is not isolation.
export function sameFileIdentity(left: Pick<Stats, "ino" | "dev">, right: Pick<Stats, "ino" | "dev">, platform: NodeJS.Platform = process.platform): boolean {
  return left.ino === right.ino && (left.dev === right.dev || (platform === "win32" && (left.dev === 0 || right.dev === 0)));
}
