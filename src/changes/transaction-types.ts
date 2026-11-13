import { z } from "zod";
import { CliError } from "../core/errors.js";
import { canonicalJSON, digest } from "../core/hash.js";
import type { CleanupPlan } from "./schema.js";

export const operationIdSchema = z.string().uuid();
const index = z.number().int().min(0).max(1999), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const phaseSchema = z.enum(["preparing", "prepared", "applying", "verifying", "restoring", "completed", "rolled-back", "restored", "recovery-required", "precheck-failed", "rejected", "cancelled"]);
export const verificationResultSchema = z.strictObject({
  phase: z.enum(["before", "after"]), script: z.string().min(1).max(4096),
  status: z.enum(["passed", "failed", "timeout", "cancelled", "not-configured", "not-run"]),
  exitCode: z.number().int().nullable(), durationMs: z.number().finite().nonnegative(),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export const eventBodySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), operationId: operationIdSchema, planId: hash, createdAt: z.string().datetime() }),
  z.strictObject({ type: z.literal("phase"), value: phaseSchema }),
  z.strictObject({ type: z.literal("backup"), index, atimeMs: z.number().finite(), mtimeMs: z.number().finite() }),
  z.strictObject({ type: z.literal("delete-intent"), index }), z.strictObject({ type: z.literal("deleted"), index }),
  z.strictObject({ type: z.literal("restore-intent"), index }),
  z.strictObject({ type: z.literal("restored"), index, outcome: z.enum(["created", "already-original"]) }),
  z.strictObject({ type: z.literal("conflict"), index, code: z.string().regex(/^[A-Z_]+$/) }),
  z.strictObject({ type: z.literal("verification"), result: verificationResultSchema }),
  z.strictObject({ type: z.literal("failure"), code: z.string().regex(/^[A-Z_]+$/), message: z.string().min(1).max(4096) }),
]);
export type JournalBody = z.infer<typeof eventBodySchema>;
export const journalEventSchema = z.strictObject({ sequence: z.number().int().nonnegative(), previous: hash.nullable(), body: eventBodySchema, hash });
export type JournalEvent = z.infer<typeof journalEventSchema>;
export interface OperationReceipt {
  operationVersion: 1; operationId: string; planId: string; project: CleanupPlan["project"];
  status: z.infer<typeof phaseSchema> | "interrupted"; journalPath: string;
  plannedPaths: string[]; attemptedPaths: string[]; changedPaths: string[]; restoredPaths: string[]; conflicts: { path: string; code: string }[];
  verification: VerificationResult[]; diagnostics: { code: string; message: string }[]; complete: boolean;
}

export function parseJournal(bytes: Buffer, plan: CleanupPlan, operationId: string): { events: JournalEvent[]; validBytes: number; truncated: boolean } {
  if (!operationIdSchema.safeParse(operationId).success || bytes.length > 16 * 1024 * 1024) throw new CliError("JOURNAL_INVALID", "Operation journal is invalid or too large.");
  const events: JournalEvent[] = []; let validBytes = 0, offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset); if (end === -1) break;
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(offset, end).toString("utf8")); } catch { throw new CliError("JOURNAL_INVALID", "A complete journal record is not valid JSON."); }
    const checked = journalEventSchema.safeParse(value);
    if (!checked.success) throw new CliError("JOURNAL_INVALID", "Operation journal has an unsupported record.");
    const event = checked.data, { hash: current, ...body } = event;
    if (current !== digest(canonicalJSON(body)) || event.sequence !== events.length || event.previous !== (events.at(-1)?.hash ?? null)) throw new CliError("JOURNAL_INVALID", "Operation journal integrity or ordering is invalid.");
    if (event.body.type === "started") {
      if (events.length || event.body.operationId !== operationId || event.body.planId !== plan.id) throw new CliError("JOURNAL_INVALID", "Operation journal does not belong to its saved plan.");
    } else if (!events.length) throw new CliError("JOURNAL_INVALID", "Operation journal is missing its start record.");
    if ("index" in event.body && !plan.operations[event.body.index]) throw new CliError("JOURNAL_INVALID", "Journal entry leaves the saved operation set.");
    if (event.body.type === "delete-intent") {
      const target = event.body.index;
      if (!events.some(({ body }) => body.type === "backup" && body.index === target)) throw new CliError("JOURNAL_INVALID", "A deletion has no recorded backup.");
    }
    events.push(event); offset = end + 1; validBytes = offset;
  }
  if (!events.length) throw new CliError("JOURNAL_INCOMPLETE", "No durable operation start record is available.");
  return { events, validBytes, truncated: validBytes !== bytes.length };
}
