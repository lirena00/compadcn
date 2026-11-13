import { randomUUID } from "node:crypto";
import { CliError } from "../core/errors.js";
import { CommandCancelled } from "../core/cancellation.js";
import { reportProgress } from "../core/progress.js";
import { discoverProject } from "../project/discover.js";
import { configurationFingerprint } from "./context.js";
import { checkCleanupPlan } from "./check.js";
import { parseCleanupPlan, type CleanupPlan } from "./schema.js";
import { takeScopeSnapshot, snapshotChanges } from "./snapshot.js";
import { ordinaryPath, readTarget, removeTarget, writeExclusive } from "./transaction-files.js";
import { acquireCleanupLock, createOperationJournal, type OperationJournal } from "./journal.js";
import { restoreJournal } from "./restore.js";
import { runVerification, validateVerificationOptions } from "../verification/run.js";
import type { CleanupPlanOptions } from "./build.js";
import type { OperationReceipt } from "./transaction-types.js";

export interface ApplyOptions extends Pick<CleanupPlanOptions, "cwd" | "env" | "offline" | "refresh" | "cacheDir" | "concurrency" | "timeoutMs" | "analysisTimeoutMs" | "signal" | "onProgress"> {
  precheck?: boolean; verificationTimeoutMs?: number;
}

async function assertScope(plan: CleanupPlan, deleted: Set<string>, options: ApplyOptions): Promise<void> {
  const current = await takeScopeSnapshot(plan.inputs.root, { excludedArtifacts: plan.inputs.excludedArtifacts, maxInputFiles: plan.inputs.limits.files, maxInputBytes: plan.inputs.limits.bytes, signal: options.signal });
  const expected = { ...plan.inputs, files: plan.inputs.files.filter(({ path }) => !deleted.has(path)) };
  const changes = snapshotChanges(expected, current);
  if (changes.length) throw new CliError("CLEANUP_SCOPE_CHANGED", "Project inputs changed outside the reviewed cleanup. This operation will restore its own deletions.", { changes });
  const project = discoverProject({ cwd: options.cwd, env: options.env });
  if (configurationFingerprint(project) !== plan.analysis.configurationFingerprint) throw new CliError("CLEANUP_CONFIGURATION_CHANGED", "Resolved project configuration changed after revalidation.");
}

async function verify(journal: OperationJournal, phase: "before" | "after", options: ApplyOptions): Promise<boolean> {
  const steps = journal.plan.verification;
  let passed = true;
  for (const step of steps) {
    reportProgress(options, { stage: "verification", state: "start", message: `${phase === "before" ? "Before" : "After"} cleanup: ${step.script}` });
    const result = passed ? await runVerification(step, phase, { ...options, cwd: ordinaryPath(journal.root, journal.plan.project.selected) }) : { phase, script: step.script, status: "not-run" as const, exitCode: null, durationMs: 0 };
    journal.append({ type: "verification", result });
    if (step.required && result.status !== "passed") passed = false;
    reportProgress(options, { stage: "verification", state: "complete", message: `${step.script}: ${result.status}` });
  }
  return passed;
}

export async function applyCleanupPlan(input: unknown, options: ApplyOptions = {}): Promise<OperationReceipt> {
  const plan = parseCleanupPlan(input);
  validateVerificationOptions({ ...options, cwd: options.cwd ?? "." });
  if (plan.status !== "ready") throw new CliError("PLAN_NOT_READY", "Apply requires a ready plan with explicit operations.");
  if (options.signal?.aborted) throw new CommandCancelled();
  const project = discoverProject({ cwd: options.cwd, env: options.env }), root = project.workspace?.root ?? project.projectRoot;
  if (root !== plan.project.root || project.projectRoot !== ordinaryPath(root, plan.project.selected)) throw new CliError("PLAN_PROJECT_MISMATCH", "Select the same workspace package that created this plan.");
  const operationId = randomUUID(), lock = acquireCleanupLock(root, operationId);
  let journal: OperationJournal | undefined;
  try {
    const checked = await checkCleanupPlan(plan, options);
    if (options.signal?.aborted) throw new CommandCancelled();
    if (!checked.valid || !checked.ready) throw new CliError("PLAN_STALE", "Current analysis could not re-establish this exact plan. Create a new plan before applying.", { check: checked });
    lock.assert();
    journal = createOperationJournal(root, operationId, plan);
    for (const [index, operation] of plan.operations.entries()) {
      lock.assert();
      const { bytes, stat } = readTarget(root, operation);
      writeExclusive(journal.backupPath(index), bytes);
      journal.append({ type: "backup", index, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs });
    }
    journal.append({ type: "phase", value: "prepared" });
    if (options.precheck) {
      if (!await verify(journal, "before", options)) {
        journal.append({ type: "failure", code: "PRECHECK_FAILED", message: "A check failed before cleanup; no deletion was started. Inspect the existing project failure." });
        journal.append({ type: "phase", value: "precheck-failed" }); return journal.receipt();
      }
    }
    await assertScope(plan, new Set(), options); lock.assert();
    if (options.signal?.aborted) throw new CliError("CLEANUP_CANCELLED", "Cleanup was cancelled before deletion.");
    journal.append({ type: "phase", value: "applying" });
    const deleted = new Set<string>();
    for (const [index, operation] of plan.operations.entries()) {
      reportProgress(options, { stage: "application", state: "start", message: `Deleting ${operation.path}`, completed: index, total: plan.operations.length });
      lock.assert();
      if (options.signal?.aborted) throw new CliError("CLEANUP_CANCELLED", "Cleanup was interrupted; restoring its own deletions.");
      journal.append({ type: "delete-intent", index });
      removeTarget(root, operation);
      journal.append({ type: "deleted", index }); deleted.add(operation.path);
      reportProgress(options, { stage: "application", state: "complete", message: `Deleted ${operation.path}`, completed: index + 1, total: plan.operations.length });
    }
    await assertScope(plan, deleted, options); lock.assert();
    journal.append({ type: "phase", value: "verifying" });
    if (!await verify(journal, "after", options)) throw new CliError("VERIFICATION_FAILED", "A required post-cleanup check failed, timed out, or was interrupted. Its deletions will be restored; check output is not persisted.");
    await assertScope(plan, deleted, options); lock.assert();
    if (options.signal?.aborted) throw new CliError("CLEANUP_CANCELLED", "Cleanup was interrupted before completion.");
    journal.append({ type: "phase", value: "completed" }); return journal.receipt();
  } catch (error) {
    if (!journal) throw error;
    const code = error instanceof CliError ? error.code : "CLEANUP_FAILED";
    try {
      lock.assert();
      journal.append({ type: "failure", code, message: error instanceof CliError ? error.message : "Cleanup stopped after an operation or filesystem failure." });
      return restoreJournal(journal, lock, options, true);
    } catch {
      return { ...journal.receipt(), status: "recovery-required", complete: false, diagnostics: [...journal.receipt().diagnostics, { code: "RECOVERY_REQUIRED", message: "Automatic recovery could not finish. Preserve the operation directory and inspect/restore this operation." }] };
    }
  } finally { lock.release(); }
}
