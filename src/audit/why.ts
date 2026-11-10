import { resolve } from "node:path";
import { CliError } from "../core/errors.js";
import { digest } from "../core/hash.js";
import type { AuditReport, WhyReport } from "./types.js";

export function explainAudit(report: AuditReport, reference: string): WhyReport {
  const paths = new Set([resolve(report.analysisRoot, reference), resolve(report.projectRoot, reference)]);
  const url = /^https?:\/\//i.test(reference) ? `URL item ${digest(reference).slice(0,12)}` : undefined;
  const targets: WhyReport["target"][] = [
    ...report.items.filter((item) => item.id === reference || item.nodeIds.includes(reference) || item.addresses.some((value) => value === reference || value.split("/").at(-1) === reference || value === url))
      .map((finding) => ({ kind: "item" as const, finding, files: report.files.filter(({ id }) => finding.files.includes(id)) })),
    ...report.files.filter((file) => file.id === reference || paths.has(file.path)).map((finding) => ({ kind: "file" as const, finding, items: report.items.filter(({ files }) => files.includes(finding.id)) })),
    ...report.packages.filter((value) => value.id === reference || value.name === reference).map((finding) => ({ kind: "package" as const, finding })),
  ];
  if (!targets.length) throw new CliError(report.complete ? "WHY_NOT_FOUND" : "WHY_UNRESOLVED", "No observed local item, managed file, or related package matches this reference.",
    report.complete ? undefined : { coverage: report.coverage, diagnostics: report.diagnostics });
  if (targets.length > 1) throw new CliError("WHY_AMBIGUOUS", "Reference matches multiple findings; select a finding ID, qualified item, or file path.", { choices: targets.map(({ kind, finding }) => ({ kind, id: finding.id, label: "label" in finding ? finding.label : "path" in finding ? finding.path : finding.name })) });
  return { auditVersion: 1, snapshotId: report.snapshotId, projectRoot: report.projectRoot, target: targets[0]!, coverage: report.coverage, diagnostics: report.diagnostics, complete: report.complete };
}
