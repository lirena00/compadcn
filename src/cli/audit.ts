import { relative } from "node:path";
import { CliError } from "../core/errors.js";
import { auditProject } from "../audit/build.js";
import { explainAudit } from "../audit/why.js";
import type { AuditReport, WhyReport } from "../audit/types.js";
import type { UsageProof } from "../analysis/reachability.js";
import type { InventoryCliOptions } from "./inventory.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";

export interface AuditCliOptions extends Omit<InventoryCliOptions, "item"> {
  maxItems: string;
  maxFiles: string;
  entry: string[];
  devEntry: string[];
  analysisTimeout: string;
  summary?: boolean;
}

export function summarizeAudit(report: AuditReport) {
  const { items: _items, files: _files, packages: _packages, roots, ...summary } = report;
  return { ...summary, rootCount: roots.length };
}

function coverageText(report: Pick<AuditReport, "coverage">): string {
  return `Coverage: ${Object.entries(report.coverage).map(([key,value])=>`${key}=${value}`).join(", ")}`;
}

function proofText(proof?: UsageProof): string[] {
  return proof ? [`Root: ${proof.root} [${proof.role}; ${proof.reason}]`,
    ...proof.path.filter(({target})=>target).map(({file,target,line,column,phase})=>`  ${file}:${line ?? "?"}:${column ?? "?"} -> ${target} [${phase ?? "runtime"}]`),
    ...(proof.truncated ? ["  Earlier proof steps omitted (64-step evidence limit)."] : [])] : [];
}

export function formatAudit(report: AuditReport, summary = false): string {
  const counts=report.counts;
  const lines=[`Project: ${report.projectRoot}`, `Audit snapshot: ${report.snapshotId}`,
    `Items: ${counts.totalItems}; runtime=${counts.runtime}, development-only=${counts.developmentOnly}, unused-candidate=${counts.unusedCandidates}, unknown=${counts.unknown}`,
    `Managed files: ${counts.localFiles}; unknown origin=${counts.unknownOriginFiles}; package candidates=${counts.packageCandidates}`,
    coverageText(report)];
  if (!summary) {
    for (const item of report.items) lines.push(`${item.label}: ${item.usage} [${item.reasons.join(", ")}]`, `  Retain: ${item.retention.join(", ")}`);
    for (const file of report.files.filter(({unmapped})=>unmapped)) lines.push(`${relative(report.analysisRoot,file.path)}: ${file.usage} [unknown origin; ${file.reasons.join(", ")}]`);
    for (const pkg of report.packages) lines.push(`${pkg.name} [${pkg.scope}]: ${pkg.status} [${pkg.reasons.join(", ")}]`);
  }
  for (const diagnostic of report.diagnostics) lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? ` [${diagnostic.path}]` : ""}`);
  lines.push("Read-only audit. Unused candidates require ownership review and a cleanup plan; no files or packages were removed.");
  lines.push(report.complete ? "Audit complete within the reported scopes and entry policy." : "Audit incomplete. Resolve diagnostics before relying on unused candidates.");
  return lines.join("\n");
}

export function formatWhy(report: WhyReport): string {
  const {finding}=report.target;
  const label="label" in finding ? finding.label : "path" in finding ? finding.path : finding.name;
  const usage="usage" in finding ? finding.usage : finding.status;
  const lines=[`${report.target.kind}: ${label}`, `Usage: ${usage}`, `Reasons: ${finding.reasons.join(", ")}`, coverageText(report)];
  if (report.target.kind === "item") {
    lines.push(`Retain: ${report.target.finding.retention.join(", ")}`, ...proofText(report.target.finding.proof));
    for (const file of report.target.files) lines.push(`File: ${file.path} [${file.usage}]`);
    for (const dependent of report.target.finding.declaredDependents) lines.push(`Registry dependent: ${dependent.label} [${dependent.usage}]`);
  } else if (report.target.kind === "file") {
    lines.push(...proofText(report.target.finding.proof));
    for (const consumer of report.target.finding.consumers) lines.push(`Consumer: ${consumer.path}:${consumer.line ?? "?"}:${consumer.column ?? "?"} [${consumer.phase}]`);
    lines.push(`Direct consumers: ${report.target.finding.consumerCount} (up to 12 shown)`);
  }
  for (const diagnostic of report.diagnostics) lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  lines.push("Cleanup eligible: false. This explanation does not authorize removal.");
  return lines.join("\n");
}

export async function runAudit(options: AuditCliOptions, outputOptions: OutputOptions, reference?: string): Promise<void> {
  if (!options.cache && options.cacheDir) throw new CliError("INVALID_OPTIONS", "Choose either --cache-dir or --no-cache.");
  const report=await auditProject({cwd:options.cwd, workspace:options.workspace, offline:options.offline, refresh:options.refresh,
    cacheDir:options.cache ? options.cacheDir : false, concurrency:Number(options.concurrency), timeoutMs:Number(options.timeout),
    maxItems:Number(options.maxItems), maxFiles:Number(options.maxFiles), analysisTimeoutMs:Number(options.analysisTimeout),
    entries:options.entry, devEntries:options.devEntry});
  const mode=getOutputMode(outputOptions);
  if (reference !== undefined) {
    const why=explainAudit(report,reference);
    const text=formatWhy(why);
    if (!why.complete) throw new CliError("AUDIT_INCOMPLETE", mode === "json" ? "Explanation has incomplete analysis coverage; inspect its diagnostics." : text, {why});
    new CliOutput(mode).success(why,text);
    return;
  }
  const data=options.summary ? summarizeAudit(report) : report;
  const text=formatAudit(report,options.summary);
  if (!report.complete) throw new CliError("AUDIT_INCOMPLETE",mode === "json" ? "Audit coverage is incomplete. Healthy findings and retention reasons are preserved." : text,{audit:data});
  new CliOutput(mode).success(data,text);
}
