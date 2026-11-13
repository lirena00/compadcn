import { digest } from "../core/hash.js";
import { CliError } from "../core/errors.js";
import { reportProgress, type ProgressOptions } from "../core/progress.js";
import { acquireCleanupLock, loadOperationJournal, type CleanupLock, type OperationJournal } from "./journal.js";
import { readStateFile, restoreExclusive } from "./transaction-files.js";
import type { OperationReceipt } from "./transaction-types.js";

export interface RestoreOptions extends ProgressOptions { cwd?: string; recoverLock?: boolean; signal?: AbortSignal }

// Restore only paths with a durable deletion intent. Missing paths are the
// expected post-state; different existing bytes are always a conflict.
export function restoreJournal(journal: OperationJournal, lock: CleanupLock, options: ProgressOptions = {}, automatic = false): OperationReceipt {
  lock.assert(); journal.recoverTail(); journal.append({ type: "phase", value: "restoring" });
  const touched = [...new Set(journal.events.flatMap(({ body }) => body.type === "delete-intent" ? [body.index] : []))].reverse();
  let conflict = false;
  for (const index of touched) {
    lock.assert();
    const operation = journal.plan.operations[index]!;
    try {
      const metadata = journal.events.flatMap(({ body }) => body.type === "backup" && body.index === index ? [body] : []).at(-1);
      if (!metadata) throw new CliError("BACKUP_MISSING", "No durable backup metadata is available.");
      const bytes = readStateFile(journal.backupPath(index), 2 * 1024 * 1024);
      if (bytes.length !== operation.before.bytes || digest(bytes) !== operation.before.sha256) throw new CliError("BACKUP_INVALID", "Backup bytes do not match the saved plan.");
      journal.append({ type: "restore-intent", index });
      const outcome = restoreExclusive(journal.root, operation, bytes, metadata);
      journal.append({ type: "restored", index, outcome });
    } catch (error) {
      const code = error instanceof CliError ? error.code : "RESTORE_FAILED";
      journal.append({ type: "conflict", index, code }); conflict = true;
    }
    reportProgress(options, { stage: "recovery", state: "complete", message: `Checked recovery for ${operation.path}` });
  }
  journal.append({ type: "phase", value: conflict ? "recovery-required" : automatic ? "rolled-back" : "restored" });
  return journal.receipt();
}

export async function restoreCleanupOperation(operationId: string, options: RestoreOptions = {}): Promise<OperationReceipt> {
  if (options.signal?.aborted) throw new CliError("RESTORE_CANCELLED", "Recovery was cancelled before it started.");
  const journal = loadOperationJournal(operationId, options.cwd), lock = acquireCleanupLock(journal.root, operationId, options.recoverLock);
  try { return restoreJournal(journal, lock, options); } finally { lock.release(); }
}

export async function inspectCleanupOperation(operationId: string, options: Pick<RestoreOptions, "cwd"> = {}): Promise<OperationReceipt> {
  return loadOperationJournal(operationId, options.cwd).receipt();
}
