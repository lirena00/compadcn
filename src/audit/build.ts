import { buildDependencyGraph, type GraphOptions } from "../graph/build.js";
import { discoverProject } from "../project/discover.js";
import { canonicalJSON, digest } from "../core/hash.js";
import { discoverRoots } from "../analysis/roots.js";
import { analyzeWithKnip, type AnalysisOptions } from "../analysis/knip.js";
import type { Diagnostic } from "../project/types.js";
import { classifyUsage } from "./classify.js";
import { auditPackages } from "./packages.js";
import type { AuditReport } from "./types.js";
import { validateAnalysisOptions } from "../analysis/options.js";

export interface AuditOptions extends Omit<GraphOptions, "scope" | "items">, AnalysisOptions { entries?: string[]; devEntries?: string[] }

export async function auditProject(options: AuditOptions = {}): Promise<AuditReport> {
  validateAnalysisOptions(options);
  const project = discoverProject({ cwd: options.cwd, env: options.env });
  const workspace = options.workspace ?? !!project.workspace;
  const graph = await buildDependencyGraph({ ...options, scope: "installed", items: undefined, workspace });
  const roots = discoverRoots(graph, project, options);
  const analysis = await analyzeWithKnip(roots, options);
  const workspaceComplete = !project.workspace || workspace;
  const classified = classifyUsage(graph, roots, analysis, workspaceComplete);
  const packages = auditPackages(graph, roots, analysis, classified.items, classified.runtime, classified.all, classified.reliable);
  const diagnostics: Diagnostic[] = [...graph.diagnostics, ...roots.diagnostics, ...analysis.all.diagnostics, ...analysis.production.diagnostics,
    ...(!workspaceComplete ? [{ code: "WORKSPACE_COVERAGE_PARTIAL", severity: "error" as const, message: "Audit requires all workspace consumers before proposing unused candidates.", path: project.workspace!.root }] : []),
    ...classified.files.filter(({ reasons }) => reasons.includes("ANALYZER_DISAGREEMENT")).map(({ path }) => ({ code: "ANALYZER_DISAGREEMENT", severity: "error" as const, message: "Usage analysis and the reference index disagree; retain this file.", path }))];
  const coverage = { graph: graph.complete, roots: roots.complete, analyzer: analysis.complete, workspace: workspaceComplete };
  const stable = { graphSnapshotId: graph.snapshotId, roots: roots.roots, items: classified.items, files: classified.files, packages, coverage, diagnostics, configFingerprint: analysis.configFingerprint };
  return {
    auditVersion: 1, snapshotId: digest(canonicalJSON(stable)), graphSnapshotId: graph.snapshotId, projectRoot: project.projectRoot, analysisRoot: roots.analysisRoot, scopes: graph.scopes,
    items: classified.items, files: classified.files, packages, roots: roots.roots,
    counts: { totalItems: classified.items.length, runtime: classified.items.filter(({ usage }) => usage === "runtime").length,
      developmentOnly: classified.items.filter(({ usage }) => usage === "development-only").length, unusedCandidates: classified.items.filter(({ usage }) => usage === "unused-candidate").length,
      unknown: classified.items.filter(({ usage }) => usage === "unknown").length, localFiles: classified.files.length, unknownOriginFiles: classified.files.filter(({ unmapped }) => unmapped).length,
      packageCandidates: packages.filter(({ status }) => status === "candidate").length },
    analysis: { engine: "knip", version: analysis.version, configFingerprint: analysis.configFingerprint, allDurationMs: analysis.all.durationMs, productionDurationMs: analysis.production.durationMs,
      allUnusedFiles: analysis.all.unusedFiles.length, productionUnusedFiles: analysis.production.unusedFiles.length },
    coverage, diagnostics, complete: Object.values(coverage).every(Boolean) && !diagnostics.some(({ severity }) => severity === "error"),
  };
}
