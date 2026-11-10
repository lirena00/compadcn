import type { Diagnostic } from "../project/types.js";
import type { EntryRoot } from "../analysis/types.js";
import type { UsageProof } from "../analysis/reachability.js";

export type UsageState = "runtime" | "development-only" | "unused-candidate" | "unknown";

export interface FileFinding {
  id: string;
  path: string;
  scope: string;
  usage: UsageState;
  reasons: string[];
  unmapped: boolean;
  knip: { allUnused: boolean; productionUnused: boolean; analyzed: boolean };
  proof?: UsageProof;
  consumers: { path: string; line?: number; column?: number; phase: string }[];
  consumerCount: number;
}

export interface ItemFinding {
  id: string;
  nodeIds: string[];
  label: string;
  addresses: string[];
  scopes: string[];
  files: string[];
  usage: UsageState;
  reasons: string[];
  retention: string[];
  proof?: UsageProof;
  declaredDependents: { id: string; label: string; usage: UsageState }[];
  cleanup: { eligible: false; blockers: string[] };
}

export interface PackageFinding {
  id: string;
  name: string;
  scope: string;
  status: "runtime" | "development-only" | "candidate" | "retain";
  reasons: string[];
  relatedItems: string[];
  cleanup: { eligible: false };
}

export interface AuditReport {
  auditVersion: 1;
  snapshotId: string;
  graphSnapshotId: string;
  projectRoot: string;
  analysisRoot: string;
  scopes: string[];
  items: ItemFinding[];
  files: FileFinding[];
  packages: PackageFinding[];
  roots: EntryRoot[];
  counts: { totalItems: number; runtime: number; developmentOnly: number; unusedCandidates: number; unknown: number; localFiles: number; unknownOriginFiles: number; packageCandidates: number };
  analysis: { engine: "knip"; version: "6.45.0"; configFingerprint: string; allDurationMs: number; productionDurationMs: number; allUnusedFiles: number; productionUnusedFiles: number };
  coverage: { graph: boolean; roots: boolean; analyzer: boolean; workspace: boolean };
  diagnostics: Diagnostic[];
  complete: boolean;
}

export interface WhyReport {
  auditVersion: 1;
  snapshotId: string;
  projectRoot: string;
  target: { kind: "item"; finding: ItemFinding; files: FileFinding[] } | { kind: "file"; finding: FileFinding; items: ItemFinding[] } | { kind: "package"; finding: PackageFinding };
  coverage: AuditReport["coverage"];
  diagnostics: Diagnostic[];
  complete: boolean;
}
