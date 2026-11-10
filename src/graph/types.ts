import type { Diagnostic } from "../project/types.js";
import type { SourceDescriptor } from "../registry/types.js";
import type { InventoryReport } from "../inventory/types.js";

export type EdgeKind = "registry-dependency" | "item-file-candidate" | "file-import" | "package-import" | "builtin-import" | "declared-package" | "item-resource";

export interface GraphNode {
  id: string;
  kind: "item" | "file" | "package" | "resource" | "unresolved";
  label: string;
  scope: string;
  state: "present" | "partial" | "absent" | "unknown" | "unresolved";
  addresses?: string[];
  sourceIds?: string[];
  itemType?: string;
  manifest?: "fetched" | "stale" | "error";
  manifestHash?: string;
  fetch?: { cache: "network" | "fresh-cache" | "revalidated" | "stale-cache"; fetchedAt: string };
  originConfidence?: "candidate" | "ambiguous" | "unknown";
  ownershipKey?: string;
  path?: string;
  contentHash?: string;
  packageName?: string;
  manifestSpec?: string;
  resourceKind?: string;
  retained?: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  status: "resolved" | "unresolved";
  phase: "runtime" | "type" | "declaration";
  evidence?: {
    path?: string;
    line?: number;
    column?: number;
    reference?: string;
    syntax?: string;
    specification?: string;
  };
  cycle?: boolean;
}

export interface GraphCycle {
  kind: "registry" | "source";
  nodes: string[];
  edges: string[];
}

export interface DependencyGraph {
  graphVersion: 1;
  snapshotId: string;
  scope: "installed" | "catalog";
  projectRoot: string;
  scopes: string[];
  seeds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
  cycles: GraphCycle[];
  sources: InventoryReport["sources"];
  registrySources: SourceDescriptor[];
  diagnostics: Diagnostic[];
  coverage: { inventory: boolean; registry: boolean; source: boolean; usage: "not-analyzed" };
  complete: boolean;
  counts: { items: number; localFiles: number; packages: number; resources: number; unresolved: number; edges: number; cycles: number };
  view?: { baseSnapshotId: string; focus: string; direction: "dependencies" | "dependents"; transitive: boolean };
}
