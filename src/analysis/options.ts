import { isAbsolute } from "node:path";
import { CliError } from "../core/errors.js";

export interface EntryOptions { entries?: string[]; devEntries?: string[] }

export function validateAnalysisOptions(options: EntryOptions & { analysisTimeoutMs?: number }): void {
  const timeout = options.analysisTimeoutMs ?? 60_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) throw new CliError("INVALID_OPTIONS", "Analysis timeout must be between 1 and 300000 milliseconds.");
  for (const patterns of [options.entries, options.devEntries]) {
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || (patterns.length && (!patterns.some((pattern) => typeof pattern === "string" && !pattern.startsWith("!")) || patterns.some((pattern) => {
      if (typeof pattern !== "string") return true;
      const value = pattern.replace(/^!/, "");
      return !value.trim() || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..");
    })))) throw new CliError("INVALID_OPTIONS", "Entry patterns must be relative to the analysis root, include a positive pattern, and stay within that root.");
  }
}
