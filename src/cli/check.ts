import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError } from "../core/errors.js";
import { CommandCancelled } from "../core/cancellation.js";
import { checkProject, createCheckBaseline } from "../check/build.js";
import { parseCheckBaseline, parseCheckPolicy, type CheckReport, type CheckBaseline } from "../check/model.js";
import { readCollectionBytes, writeNewFile } from "../collections/files.js";
import { assertArtifactDestination } from "../changes/io.js";
import { discoverProject } from "../project/discover.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import { runTask } from "./task.js";
import { terminalText } from "./text.js";
import type { AuditCliOptions } from "./audit.js";

export interface CheckCliOptions extends AuditCliOptions { policy?: string; baseline?: string; limit: string; includeKnown?: boolean; out?: string }

function formatCheck(report: CheckReport): string {
  return [`Check: ${report.status} [${report.project.selected}]`, `New errors: ${report.counts.newErrors}; new warnings: ${report.counts.newWarnings}; accepted: ${report.baseline.accepted}; resolved: ${report.baseline.resolved}`,
    `Coverage: ${Object.entries(report.coverage).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    ...report.findings.flatMap(finding => [`${finding.level.toUpperCase()} ${finding.rule}: ${terminalText(finding.target)}${finding.known ? " [accepted baseline]" : ""}`, `  Reference: ${finding.reference}; scopes: ${finding.scopes.map(scope => terminalText(scope)).join(", ")}`]),
    ...(report.omittedFindings ? [`${report.omittedFindings} additional findings omitted from this response; counts include every finding.`] : []),
    ...report.diagnostics.map(entry => `${entry.severity.toUpperCase()} ${entry.code}: ${terminalText(entry.message, 1000)}${entry.path ? ` [${terminalText(entry.path, 4096)}]` : ""}`),
    ...(report.omittedDiagnostics ? [`${report.omittedDiagnostics} additional diagnostics; inspect audit for full evidence.`] : []),
    "Read-only policy check. Use why <reference> for details; findings and baseline waivers do not authorize cleanup."].join("\n");
}

export async function runCheck(options: CheckCliOptions, outputOptions: OutputOptions, capture = false): Promise<void> {
  if (!options.cache && options.cacheDir) throw new CliError("INVALID_OPTIONS", "Choose either --cache-dir or --no-cache.");
  const policy = parseCheckPolicy(options.policy ? (await readCollectionBytes(options.policy, 16 * 1024 * 1024)).toString("utf8") : undefined);
  const baseline = options.baseline ? parseCheckBaseline((await readCollectionBytes(options.baseline, 16 * 1024 * 1024)).toString("utf8")) : undefined;
  const output = capture ? assertArtifactDestination(discoverProject({ cwd: options.cwd }), options.out!) : undefined;
  const mode = getOutputMode(outputOptions);
  try {
    const result = await runTask<CheckReport | CheckBaseline>(capture ? "Baseline" : "Check", outputOptions, task => {
      const inputs = { cwd: options.cwd, policy, limit: Number(options.limit), summary: options.summary, includeKnown: options.includeKnown,
        offline: options.offline, refresh: options.refresh, cacheDir: options.cache ? options.cacheDir : false as const, concurrency: Number(options.concurrency), timeoutMs: Number(options.timeout),
        maxItems: Number(options.maxItems), maxFiles: Number(options.maxFiles), analysisTimeoutMs: Number(options.analysisTimeout), entries: options.entry, devEntries: options.devEntry, signal: task.signal, onProgress: task.onProgress };
      return capture ? createCheckBaseline(inputs) : checkProject({ ...inputs, baseline });
    });
    if ("baselineVersion" in result) {
      const bytes = JSON.stringify(parseCheckBaseline(result), null, 2) + "\n";
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new CliError("CHECK_BASELINE_INVALID", "Baseline exceeds the 16 MiB artifact limit.");
      await mkdir(dirname(output!), { recursive: true });
      await writeNewFile(output!, bytes);
      new CliOutput(mode).success({ baseline: { baselineVersion: result.baselineVersion, id: result.id, project: result.project, entries: result.entries.length, contextFingerprint: result.contextFingerprint, policyFingerprint: result.policyFingerprint }, output },
        `Baseline: ${result.id}\nRecorded ${result.entries.length} findings for review. No issues were fixed.\n${terminalText(output!, 4096)}\nPassing --baseline accepts these reviewed findings; coverage failures remain blocking.`);
      return;
    }
    const text = formatCheck(result);
    if (result.status !== "passed") throw new CliError(result.status === "failed" ? "CHECK_FAILED" : "CHECK_INCOMPLETE", mode === "json" ? `Policy check ${result.status}; inspect its complete counts and coverage.` : text, { check: result }, result.status === "failed" ? 1 : 2);
    new CliOutput(mode).success({ check: result }, text);
  } catch (error) {
    if (error instanceof CommandCancelled) throw new CliError("CHECK_INTERRUPTED", "Check was interrupted; CI coverage was not established.");
    throw error;
  }
}
