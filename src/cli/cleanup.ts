import { CliError } from "../core/errors.js";
import { CommandCancelled } from "../core/cancellation.js";
import { readArtifact } from "../changes/io.js";
import { parseCleanupPlan } from "../changes/schema.js";
import type { OperationReceipt } from "../changes/transaction-types.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import { runTask } from "./task.js";
import { terminalText } from "./text.js";

interface CleanupCliOptions { cwd: string; yes?: boolean; recoverLock?: boolean }
export interface ApplyCliOptions extends CleanupCliOptions {
  plan: string; precheck?: boolean; verificationTimeout: string; offline?: boolean; refresh?: boolean; cache: boolean;
  cacheDir?: string; concurrency: string; timeout: string; analysisTimeout: string;
}

async function confirmMutation(options: CleanupCliOptions, output: OutputOptions, message: string, details: string): Promise<void> {
  if (options.yes) return;
  if (getOutputMode(output) !== "interactive") throw new CliError("INTERACTIVE_REQUIRED", "Use --yes to authorize this exact cleanup or recovery noninteractively.");
  const { confirm, note, isCancel } = await import("@clack/prompts");
  note(details, "Review cleanup operation");
  const answer = await confirm({ message, initialValue: false });
  if (isCancel(answer) || !answer) throw new CommandCancelled();
}

export function formatOperation(operation: OperationReceipt): string {
  return [`Operation: ${operation.operationId}`, `Plan: ${operation.planId}`, `Status: ${operation.status}`,
    `Planned: ${operation.plannedPaths.length}; attempted: ${operation.attemptedPaths.length}; deleted: ${operation.changedPaths.length}; recovered: ${operation.restoredPaths.length}; conflicts: ${operation.conflicts.length}`,
    ...operation.attemptedPaths.filter(path=>!operation.changedPaths.includes(path)).map(path=>`ATTEMPTED ${terminalText(path,4096)} (completion not recorded)`),
    ...operation.changedPaths.map(path => `DELETED ${terminalText(path, 4096)}`),
    ...operation.restoredPaths.map(path => `RECOVERED ${terminalText(path, 4096)}`),
    ...operation.conflicts.map(({ path, code }) => `CONFLICT ${terminalText(path, 4096)}: ${code}`),
    ...operation.verification.map(step => `${step.phase} ${terminalText(step.script)}: ${step.status}${step.exitCode === null ? "" : ` (exit ${step.exitCode})`}`),
    ...operation.diagnostics.map(({ code, message }) => `${code}: ${terminalText(message, 1000)}`),
    `Journal: ${terminalText(operation.journalPath, 4096)}`,
    ...(operation.status === "recovery-required" || operation.status === "interrupted" ? [`Inspect with operation ${operation.operationId}; recover with restore ${operation.operationId}.`] : []),
  ].join("\n");
}

function writeResult(operation: OperationReceipt, outputOptions: OutputOptions, inspect = false): void {
  const mode = getOutputMode(outputOptions), text = formatOperation(operation);
  if (!inspect && !["completed", "restored"].includes(operation.status)) {
    const code = operation.status === "rolled-back" ? "CLEANUP_ROLLED_BACK" : operation.status === "precheck-failed" ? "CLEANUP_PRECHECK_FAILED" : "CLEANUP_RECOVERY_REQUIRED";
    throw new CliError(code, mode === "json" ? `Cleanup finished with status ${operation.status}; inspect the operation receipt.` : text, { operation });
  }
  new CliOutput(mode).success({ operation }, text);
}

export async function runApply(options: ApplyCliOptions, output: OutputOptions): Promise<void> {
  if (!options.cache && options.cacheDir) throw new CliError("INVALID_OPTIONS", "Choose either --cache-dir or --no-cache.");
  // Fail before reading a project or starting analysis when consent is absent.
  if (!options.yes && getOutputMode(output) !== "interactive") throw new CliError("INTERACTIVE_REQUIRED", "Use --yes to apply an explicitly saved cleanup plan noninteractively.");
  const plan = parseCleanupPlan(await readArtifact(options.plan));
  if (plan.status !== "ready") throw new CliError("PLAN_NOT_READY", "Apply requires a ready plan with explicit operations.");
  await confirmMutation(options, output, `Apply ${plan.operations.length} exact file deletions and run its configured checks?`,
    [`Plan: ${plan.id}`, `Project: ${terminalText(plan.project.root, 4096)} / ${terminalText(plan.project.selected)}`,
      ...plan.operations.map(operation => `DELETE ${terminalText(operation.path, 4096)}`),
      `Checks: ${plan.verification.map(step => `${step.script} (${step.status})`).join(", ")}`,
      "Backups cover these files. Check scripts may write other project files; recovery preserves those writes."].join("\n"));
  const result = await runTask("Apply", output, async task => {
    const { applyCleanupPlan } = await import("../changes/apply.js");
    task.beginMutation();
    return applyCleanupPlan(plan, { cwd: options.cwd, precheck: options.precheck, verificationTimeoutMs: Number(options.verificationTimeout),
      offline: options.offline, refresh: options.refresh, cacheDir: options.cache ? options.cacheDir : false, concurrency: Number(options.concurrency),
      timeoutMs: Number(options.timeout), analysisTimeoutMs: Number(options.analysisTimeout), signal: task.signal, onProgress: task.onProgress });
  }, { handlesCancellation: true });
  writeResult(result, output);
}

export async function runRestore(id: string, options: CleanupCliOptions, output: OutputOptions): Promise<void> {
  if (!options.yes && getOutputMode(output) !== "interactive") throw new CliError("INTERACTIVE_REQUIRED", "Use --yes to restore an explicitly selected operation noninteractively.");
  const { inspectCleanupOperation, restoreCleanupOperation } = await import("../changes/restore.js");
  const receipt = await inspectCleanupOperation(id, { cwd: options.cwd });
  await confirmMutation(options, output, `Restore this operation's ${receipt.attemptedPaths.length} attempted file deletions where they are still missing?`, `${formatOperation(receipt)}\nExisting different files are retained as conflicts. Recovery does not undo verification-script side effects.`);
  const result = await runTask("Restore", output, async task => {
    task.beginMutation();
    return restoreCleanupOperation(id, { ...options, signal: task.signal, onProgress: task.onProgress });
  }, { handlesCancellation: true });
  writeResult(result, output);
}

export async function runOperation(id: string, options: CleanupCliOptions, output: OutputOptions): Promise<void> {
  const { inspectCleanupOperation } = await import("../changes/restore.js");
  writeResult(await inspectCleanupOperation(id, { cwd: options.cwd }), output, true);
}
