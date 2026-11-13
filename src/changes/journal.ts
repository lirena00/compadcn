import { appendFileSync, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CliError } from "../core/errors.js";
import { sameFileIdentity } from "../core/file-identity.js";
import { canonicalJSON, digest } from "../core/hash.js";
import { ancestors, canonicalPath, isWithin } from "../project/files.js";
import { parseCleanupPlan, type CleanupPlan } from "./schema.js";
import { ordinaryPath, readStateFile, stateDirectory, writeExclusive } from "./transaction-files.js";
import { operationIdSchema, parseJournal, type JournalBody, type JournalEvent, type OperationReceipt } from "./transaction-types.js";

const lockSchema = z.strictObject({ token: z.string().uuid(), operationId: operationIdSchema, pid: z.number().int().positive(), host: z.string().min(1), createdAt: z.string().datetime() });
export interface CleanupLock { assert(): void; release(): void }

export function acquireCleanupLock(root: string, operationId: string, recover = false): CleanupLock {
  const state = stateDirectory(root), path = join(state, "cleanup.lock"), gate = join(state, "cleanup-recovery.lock");
  const owner = { token: randomUUID(), operationId, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
  const blocked = () => {
    let details: Record<string, unknown> | undefined;
    try { const previous = lockSchema.parse(JSON.parse(readStateFile(path, 16384).toString("utf8"))); details = { operationId: previous.operationId, processId: previous.pid, host: previous.host }; } catch { /* A malformed lock requires inspection, not takeover. */ }
    return new CliError("CLEANUP_LOCKED", `Workspace cleanup is locked${details ? ` by operation ${details.operationId}` : ""}. Inspect its operation; use restore --recover-lock only after its process has stopped.`, details);
  };
  try { lstatSync(gate); throw blocked(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const create = () => { try { writeExclusive(path, JSON.stringify(owner)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw blocked(); throw error; } };
  if (recover) {
    let previous: z.infer<typeof lockSchema> | undefined;
    try { previous = lockSchema.parse(JSON.parse(readStateFile(path, 16384).toString("utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw blocked(); }
    if (previous) {
      if (previous.host !== hostname() || previous.operationId !== operationId) throw blocked();
      let dead = false;
      try { process.kill(previous.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!dead) throw blocked();
      try { writeExclusive(gate, JSON.stringify(owner)); } catch { throw blocked(); }
      try {
        const current = lockSchema.parse(JSON.parse(readStateFile(path, 16384).toString("utf8")));
        if (canonicalJSON(current) !== canonicalJSON(previous)) throw blocked();
        renameSync(path, join(state, `recovered-lock-${randomUUID()}.json`));
        create();
      } finally { if (JSON.parse(readStateFile(gate, 16384).toString("utf8")).token === owner.token) unlinkSync(gate); }
    } else create();
  } else create();
  const assert = () => {
    try { if (JSON.parse(readStateFile(path, 16384).toString("utf8")).token === owner.token && canonicalPath(state) === state) return; } catch { /* Lost locks never authorize more writes. */ }
    throw new CliError("CLEANUP_LOCK_LOST", "Workspace cleanup lock changed. Stop and inspect the operation record.");
  };
  return { assert, release() { try { assert(); } catch { return; } unlinkSync(path); } };
}

export class OperationJournal {
  readonly path: string;
  constructor(readonly root: string, readonly directory: string, readonly operationId: string, readonly plan: CleanupPlan, readonly events: JournalEvent[], public validBytes: number, public truncated = false) {
    this.path = join(directory, "journal.jsonl");
  }
  backupPath(index: number): string { if (!this.plan.operations[index]) throw new CliError("JOURNAL_INVALID", "Unknown backup index."); return ordinaryPath(this.directory, `backups/${index}.bin`); }
  append(body: JournalBody): void {
    ordinaryPath(this.root, this.path.slice(this.root.length + 1).replaceAll("\\", "/"));
    if (this.truncated) throw new CliError("JOURNAL_TRUNCATED", "Recover the interrupted journal tail before appending records.");
    const payload = { sequence: this.events.length, previous: this.events.at(-1)?.hash ?? null, body };
    const event = { ...payload, hash: digest(canonicalJSON(payload)) };
    const bytes = JSON.stringify(event) + "\n";
    if (this.validBytes + Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new CliError("JOURNAL_LIMIT", "Operation journal reached its size limit.");
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== this.validBytes) throw new CliError("JOURNAL_CHANGED", "Operation journal changed outside its writer.");
    const fd = openSync(this.path, "a");
    try { if (!sameFileIdentity(fstatSync(fd), stat)) throw new CliError("JOURNAL_CHANGED", "Journal identity changed."); appendFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    this.events.push(event); this.validBytes += Buffer.byteLength(bytes);
  }
  recoverTail(): void {
    if (!this.truncated) return;
    const bytes = readStateFile(this.path, 16 * 1024 * 1024);
    writeExclusive(join(this.directory, `interrupted-tail-${randomUUID()}.bin`), bytes.subarray(this.validBytes));
    const fd = openSync(this.path, "r+");
    try { ftruncateSync(fd, this.validBytes); fsyncSync(fd); } finally { closeSync(fd); }
    this.truncated = false;
  }
  receipt(): OperationReceipt {
    const phases = this.events.flatMap(({ body }) => body.type === "phase" ? [body.value] : []);
    const phase = phases.at(-1) ?? "preparing";
    const changed = new Set<number>(), restored = new Set<number>(), conflicts = new Map<number, string>();
    for (const { body } of this.events) {
      if (body.type === "deleted") changed.add(body.index);
      if (body.type === "restored") { restored.add(body.index); conflicts.delete(body.index); }
      if (body.type === "conflict") conflicts.set(body.index, body.code);
    }
    return { operationVersion: 1, operationId: this.operationId, planId: this.plan.id, project: this.plan.project,
      status: ["preparing", "prepared", "applying", "verifying", "restoring"].includes(phase) ? "interrupted" : phase,
      journalPath: this.path, plannedPaths: this.plan.operations.map(operation=>operation.path),
      attemptedPaths: [...new Set(this.events.flatMap(({body})=>body.type==="delete-intent"?[body.index]:[]))].map(index=>this.plan.operations[index]!.path),
      changedPaths: [...changed].map(index => this.plan.operations[index]!.path), restoredPaths: [...restored].map(index => this.plan.operations[index]!.path),
      conflicts: [...conflicts].map(([index, code]) => ({ path: this.plan.operations[index]!.path, code })),
      verification: this.events.flatMap(({ body }) => body.type === "verification" ? [body.result] : []),
      diagnostics: [...this.events.flatMap(({ body }) => body.type === "failure" ? [{ code: body.code, message: body.message }] : []), ...(this.truncated ? [{ code: "JOURNAL_TRUNCATED", message: "An interrupted final journal record was ignored; recovery preserves its bytes." }] : [])],
      complete: ["completed", "rolled-back", "restored", "precheck-failed", "rejected", "cancelled"].includes(phase) && !conflicts.size && !this.truncated };
  }
}

export function createOperationJournal(root: string, operationId: string, plan: CleanupPlan): OperationJournal {
  const savedPlan = JSON.stringify(plan) + "\n";
  if (Buffer.byteLength(savedPlan) > 64 * 1024 * 1024) throw new CliError("PLAN_ARTIFACT_INVALID", "The operation's saved plan exceeds its recovery size limit.");
  stateDirectory(root); const operations = ordinaryPath(root, ".shadcn-plus/operations");
  mkdirSync(operations, { recursive: true, mode: 0o700 });
  const directory = ordinaryPath(root, `.shadcn-plus/operations/${operationId}`);
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, "backups"), { mode: 0o700 });
  writeExclusive(join(directory, "plan.json"), savedPlan);
  writeExclusive(join(directory, "journal.jsonl"), "");
  const journal = new OperationJournal(root, directory, operationId, plan, [], 0);
  journal.append({ type: "started", operationId, planId: plan.id, createdAt: new Date().toISOString() });
  return journal;
}

export function loadOperationJournal(operationId: string, cwd = "."): OperationJournal {
  if (!operationIdSchema.safeParse(operationId).success) throw new CliError("OPERATION_ID_INVALID", "Use a cleanup operation UUID, not a file path.");
  const selected = canonicalPath(resolve(cwd));
  for (const root of ancestors(selected)) {
    const directory = ordinaryPath(root, `.shadcn-plus/operations/${operationId}`), path = join(directory, "plan.json");
    let bytes: Buffer;
    try { bytes = readStateFile(path, 64 * 1024 * 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const plan = parseCleanupPlan(bytes.toString("utf8"));
    if (plan.project.root !== root || !isWithin(ordinaryPath(root, plan.project.selected), selected)) throw new CliError("OPERATION_PROJECT_MISMATCH", "Select the workspace package that owns this operation.");
    const journal = readStateFile(join(directory, "journal.jsonl"), 16 * 1024 * 1024), parsed = parseJournal(journal, plan, operationId);
    return new OperationJournal(root, directory, operationId, plan, parsed.events, parsed.validBytes, parsed.truncated);
  }
  throw new CliError("OPERATION_NOT_FOUND", "No cleanup operation with this ID was found above the selected directory.");
}
