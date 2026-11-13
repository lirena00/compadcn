import { applyPatch, createTwoFilesPatch, parsePatch, reversePatch } from "diff";
import { CliError } from "../core/errors.js";
import { digest } from "../core/hash.js";

export function deletionDiff(path: string, content: string): string {
  const label = /\s|"/.test(path) ? JSON.stringify(`a/${path}`) : `a/${path}`;
  return createTwoFilesPatch(label, "/dev/null", content, "", "", "", { context: 3 });
}

export function validateDeletionDiff(path: string, diff: string, hash: string, bytes: number): void {
  try {
    const patches = parsePatch(diff);
    if (patches.length !== 1) throw new Error("Not one deletion");
    const content = applyPatch("", reversePatch(patches[0]!));
    if (content === false || Buffer.byteLength(content) !== bytes || digest(content) !== hash || deletionDiff(path, content) !== diff) throw new Error("Preview mismatch");
  } catch { throw new CliError("PLAN_PREVIEW_INVALID", "Deletion preview does not exactly describe the planned file bytes and path."); }
}
