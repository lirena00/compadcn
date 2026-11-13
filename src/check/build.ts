import { readFileSync } from "node:fs";
import { CliError } from "../core/errors.js";
import { canonicalJSON, digest } from "../core/hash.js";
import { packageInfo } from "../lib/packageInfo.js";
import { createAuditSession, type AuditOptions } from "../audit/build.js";
import { discoverProject } from "../project/discover.js";
import { localPath } from "../changes/paths.js";
import { checkContext } from "./context.js";
import type { Diagnostic } from "../project/types.js";
import { identifyFinding, parseCheckBaseline, parseCheckPolicy, rules, sealBaseline, type CheckBaseline, type CheckFinding, type CheckReport } from "./model.js";

export interface CheckOptions extends Omit<AuditOptions, "workspace"> { policy?: unknown; baseline?: unknown; limit?: number; summary?: boolean; includeKnown?: boolean }

async function analyzeCheck(options: CheckOptions) {
  if (!Number.isInteger(options.limit ?? 20) || (options.limit ?? 20) < 0 || (options.limit ?? 20) > 200) throw new CliError("INVALID_OPTIONS", "Check output limit must be 0–200 findings.");
  const policy = parseCheckPolicy(options.policy), baseline = options.baseline === undefined ? undefined : parseCheckBaseline(options.baseline);
  const selected = discoverProject({ cwd: options.cwd, env: options.env }), before = checkContext(selected, options);
  const session = await createAuditSession({ ...options, workspace: true });
  const { report, graph, project } = session, root = before.root;
  const after = checkContext(discoverProject({ cwd: options.cwd, env: options.env }), options);
  const identity = { selected: localPath(root, project.projectRoot), scopes: report.scopes.map(scope => localPath(root, scope)).sort() };
  const policyFingerprint = digest(canonicalJSON(policy)), files = new Map(report.files.map(file => [file.id, file])), nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const findings: (CheckFinding & { reference: string })[] = [];
  const inputDiagnostics: Diagnostic[] = [], evidenceCache = new Map<string, string>();
  const fileEvidence = (id: string): string => {
    const cached = evidenceCache.get(id); if (cached) return cached;
    const file = files.get(id)!; let value: string;
    try {
      const bytes = readFileSync(file.path);
      if (nodes.get(id)?.contentHash !== digest(bytes)) throw new Error("Changed source");
      // Baseline hygiene identities tolerate Git checkout line endings. Cleanup
      // operations continue to use their independent exact-byte preconditions.
      value = digest(bytes.toString("utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"));
    } catch {
      inputDiagnostics.push({ code: "CHECK_INPUT_CHANGED", severity: "error", message: "A finding's source changed after analysis; rerun check.", path: file.path });
      value = digest("unavailable");
    }
    evidenceCache.set(id, value); return value;
  };
  const add = (rule: CheckFinding["rule"], reference: string, finding: Omit<CheckFinding, "id" | "rule" | "level">) => {
    const level = policy.rules[rule]; if (level === "off") return;
    findings.push({ ...identifyFinding({ ...finding, rule, level }), reference });
  };
  for (const item of report.items) {
    const rule = item.usage === "unused-candidate" ? "unused-item" : item.usage === "unknown" ? "unknown-usage" : undefined;
    if (!rule || policy.rules[rule] === "off") continue;
    const paths = item.files.map(id => localPath(root, files.get(id)!.path)).sort();
    const evidence = { files: item.files.map(id => [localPath(root, files.get(id)!.path), fileEvidence(id)]).sort(), manifests: item.nodeIds.map(id => nodes.get(id)?.manifestHash).sort() };
    const finding = { kind: "item" as const, target: item.label, scopes: item.scopes.map(scope => localPath(root, scope)).sort(), paths, addresses: [...item.addresses].sort(),
      reasons: [...new Set([...item.reasons, ...item.retention])].sort(), evidenceFingerprint: digest(canonicalJSON(evidence)) };
    add(rule, item.id, finding);
  }
  for (const file of report.files.filter(file => file.unmapped)) {
    const rule = file.usage === "unused-candidate" ? "unused-file" : file.usage === "unknown" ? "unknown-usage" : undefined;
    if (!rule || policy.rules[rule] === "off") continue;
    const path = localPath(root, file.path), finding = { kind: "file" as const, target: path, scopes: [localPath(root, file.scope)], paths: [path], addresses: [], reasons: [...file.reasons].sort(), evidenceFingerprint: digest(canonicalJSON([path, fileEvidence(file.id)])) };
    add(rule, file.id, finding);
  }
  for (const pkg of report.packages.filter(pkg => pkg.status === "candidate")) add("unused-package", pkg.id, { kind: "package", target: pkg.name, scopes: [localPath(root, pkg.scope)], paths: [], addresses: [], reasons: [...pkg.reasons].sort(),
    evidenceFingerprint: digest(canonicalJSON(graph.nodes.filter(node => node.kind === "package" && node.packageName === pkg.name && node.scope === pkg.scope).map(node => node.manifestSpec).sort())) });
  findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
  const compatible = !baseline || (canonicalJSON(baseline.project) === canonicalJSON(identity) && baseline.contextFingerprint === before.fingerprint && baseline.policyFingerprint === policyFingerprint);
  const accepted = new Set(compatible ? baseline?.entries.map(entry => entry.id) : []), current = new Set(findings.map(finding => finding.id));
  const diagnostics = [...report.diagnostics, ...before.diagnostics, ...after.diagnostics, ...inputDiagnostics].map(entry => ({ ...entry, message: entry.message.replaceAll(root, "[workspace]"), ...(entry.path ? { path: (() => { try { return localPath(root, entry.path!); } catch { return "[outside workspace]"; } })() } : {}) }));
  if (before.fingerprint !== after.fingerprint) diagnostics.push({ code: "CHECK_CONTEXT_CHANGED", severity: "error", message: "Project configuration changed during check; rerun it." });
  if (!compatible) diagnostics.push({ code: "CHECK_BASELINE_CONTEXT_CHANGED", severity: "error", message: "Baseline project, entry/configuration context, or policy changed. Review findings before creating a new baseline." });
  const complete = report.complete && before.fingerprint === after.fingerprint && compatible && !diagnostics.some(entry => entry.severity === "error");
  const all = findings.map(finding => ({ ...finding, known: accepted.has(finding.id) }));
  const errors = all.filter(finding => finding.level === "error"), warnings = all.filter(finding => finding.level === "warning");
  const newErrors = errors.filter(finding => !finding.known).length, newWarnings = warnings.filter(finding => !finding.known).length;
  const visible = all.filter(finding => options.includeKnown || !finding.known), limit = options.summary ? 0 : options.limit ?? 20;
  const result: CheckReport = { checkVersion: 1, status: !complete ? "incomplete" : newErrors ? "failed" : "passed", complete, project: identity,
    contextFingerprint: before.fingerprint, policyFingerprint, auditSnapshotId: report.snapshotId, coverage: report.coverage, auditCounts: report.counts, policy,
    baseline: { provided: !!baseline, compatible, accepted: all.filter(finding => finding.known).length, resolved: compatible ? (baseline?.entries.filter(entry => !current.has(entry.id)).length ?? 0) : 0 },
    counts: { total: all.length, errors: errors.length, warnings: warnings.length, newErrors, newWarnings, known: all.filter(finding => finding.known).length, byRule: Object.fromEntries(rules.map(rule => [rule, all.filter(finding => finding.rule === rule).length])) as CheckReport["counts"]["byRule"] },
    findings: visible.slice(0, limit).map(({ evidenceFingerprint: _evidence, ...finding }) => ({ ...finding, paths: finding.paths.slice(0, 8), addresses: finding.addresses.slice(0, 4), scopes: finding.scopes.slice(0, 4), reasons: finding.reasons.slice(0, 8),
      omitted: { paths: Math.max(0, finding.paths.length - 8), addresses: Math.max(0, finding.addresses.length - 4), scopes: Math.max(0, finding.scopes.length - 4), reasons: Math.max(0, finding.reasons.length - 8) } })),
    omittedFindings: visible.length - Math.min(limit, visible.length), diagnostics: diagnostics.slice(0, 20), omittedDiagnostics: Math.max(0, diagnostics.length - 20) };
  return { result, entries: findings.map(({ reference: _reference, ...finding }) => finding), project };
}

export async function checkProject(options: CheckOptions = {}): Promise<CheckReport> { return (await analyzeCheck(options)).result; }
export async function createCheckBaseline(options: Omit<CheckOptions, "baseline"> = {}): Promise<CheckBaseline> {
  const { result, entries } = await analyzeCheck(options);
  if (!result.complete) throw new CliError("CHECK_BASELINE_INCOMPLETE", "A baseline cannot accept incomplete analysis. Resolve coverage diagnostics first.", { check: result });
  return parseCheckBaseline(sealBaseline({ baselineVersion: 1, toolVersion: packageInfo.version, engines: { knip: "6.45.0", typescript: "5.8.3" }, project: result.project,
    contextFingerprint: result.contextFingerprint, policyFingerprint: result.policyFingerprint, entries }));
}
