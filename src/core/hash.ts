import { createHash } from "node:crypto";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
