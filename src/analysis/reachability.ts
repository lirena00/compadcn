import type { DependencyGraph, GraphEdge, GraphNode } from "../graph/types.js";
import type { EntryRoot } from "./types.js";

export interface ReachRecord { root: EntryRoot; parent?: string; edge?: GraphEdge; depth: number; typeOnly: boolean }
export type ReachIndex = Map<string, ReachRecord>;

export function reachable(graph: DependencyGraph, roots: EntryRoot[], runtimeOnly: boolean): ReachIndex {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "file-import" || edge.status !== "resolved" || (runtimeOnly && edge.phase !== "runtime")) continue;
    const rows = outgoing.get(edge.from) ?? []; rows.push(edge); outgoing.set(edge.from, rows);
  }
  for (const rows of outgoing.values()) rows.sort((a, b) => a.id.localeCompare(b.id));
  const result: ReachIndex = new Map();
  const pending: string[] = [];
  for (const root of roots) if (!result.has(root.id)) { result.set(root.id, { root, depth: 0, typeOnly: false }); pending.push(root.id); }
  for (let offset = 0; offset < pending.length; offset++) {
    const current = pending[offset]!;
    for (const edge of outgoing.get(current) ?? []) if (!result.has(edge.to)) {
      const previous = result.get(current)!;
      result.set(edge.to, { root: previous.root, parent: current, edge, depth: previous.depth + 1, typeOnly: previous.typeOnly || edge.phase === "type" }); pending.push(edge.to);
    }
  }
  return result;
}

export interface UsageProof {
  root: string;
  role: EntryRoot["role"];
  reason: string;
  path: { file: string; target?: string; line?: number; column?: number; phase?: string; syntax?: string }[];
  truncated: boolean;
  typeOnly: boolean;
}

export function proofFor(id: string, index: ReachIndex, graph: DependencyGraph, nodes: ReadonlyMap<string, GraphNode> = new Map(graph.nodes.map((node) => [node.id, node]))): UsageProof | undefined {
  const first = index.get(id);
  if (!first) return undefined;
  const path: UsageProof["path"] = [];
  let current: string | undefined = id;
  let count = 0;
  while (current && count++ < 64) {
    const record: ReachRecord = index.get(current)!;
    path.push({ file: record.edge?.evidence?.path ?? nodes.get(current)?.path ?? current,
      ...(record.edge ? { target: nodes.get(current)?.path ?? current } : {}),
      ...(record.edge?.evidence ? { line: record.edge.evidence.line, column: record.edge.evidence.column, syntax: record.edge.evidence.syntax, phase: record.edge.phase } : {}) });
    current = record.parent;
  }
  return { root: first.root.path, role: first.root.role, reason: first.root.reason, path: path.reverse(), truncated: first.depth >= 64, typeOnly: first.typeOnly };
}
