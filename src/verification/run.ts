import { execa } from "execa";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readObject } from "../project/files.js";
import { digest } from "../core/hash.js";
import { CliError } from "../core/errors.js";
import type { CleanupPlan } from "../changes/schema.js";
import type { VerificationResult } from "../changes/transaction-types.js";

export interface VerificationOptions { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; verificationTimeoutMs?: number }

export function validateVerificationOptions(options: VerificationOptions): void {
  const timeout = options.verificationTimeoutMs ?? 120000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800000) throw new CliError("INVALID_OPTIONS", "Verification timeout must be 1–1800000 milliseconds per script.");
}

export async function runVerification(step: CleanupPlan["verification"][number], phase: "before" | "after", options: VerificationOptions): Promise<VerificationResult> {
  validateVerificationOptions(options);
  const started = performance.now();
  const result = (status: VerificationResult["status"], exitCode: number | null = null): VerificationResult => ({ phase, script: step.script, status, exitCode, durationMs: performance.now() - started });
  if (step.status !== "configured") return result("not-configured");
  if (options.signal?.aborted) return result("cancelled");
  const manifest = readObject(join(options.cwd, "package.json"), "VERIFICATION_CONFIGURATION_CHANGED");
  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  if (typeof scripts?.[step.script] !== "string" || digest(scripts[step.script] as string) !== step.scriptHash) throw new CliError("VERIFICATION_CONFIGURATION_CHANGED", "A verification script changed after planning.");
  let timedOut = false, cancelled = false, termination: Promise<unknown> | undefined;
  const child = execa(step.command, step.args, { cwd: options.cwd, env: { ...process.env, ...options.env, CI: "1", NO_COLOR: "1" },
    stdio: "ignore", reject: false, detached: process.platform !== "win32", windowsHide: true });
  const stop = () => {
    if (termination || !child.pid) return;
    if (process.platform === "win32") termination = execa(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { reject: false, stdio: "ignore", windowsHide: true }).then(() => { child.kill(); });
    else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
      termination = new Promise<void>((done) => { setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* The group already exited. */ } done(); }, 1000); });
    }
  };
  const abort = () => { cancelled = true; stop(); };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.verificationTimeoutMs ?? 120000);
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("spawn", () => { if (cancelled || timedOut || options.signal?.aborted) stop(); });
  if (options.signal?.aborted) abort();
  try {
    const execution = await child; await termination;
    return result(timedOut ? "timeout" : cancelled ? "cancelled" : execution.failed || execution.exitCode !== 0 ? "failed" : "passed", execution.exitCode ?? null);
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
}
