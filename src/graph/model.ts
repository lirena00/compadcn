import { CliError } from "../core/errors.js";
import { digest } from "../core/hash.js";
import type { DependencyGraph, EdgeKind, GraphCycle, GraphEdge, GraphNode } from "./types.js";

export const nodeId = (...parts: string[]): string => `n${digest(JSON.stringify(parts))}`;
export const fileId = (path: string): string => nodeId("file", path);

export class GraphStore {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  node(node: GraphNode): string {
    const previous = this.nodes.get(node.id);
    this.nodes.set(node.id, { ...previous, ...node,
      ...(previous?.addresses || node.addresses ? { addresses: [...new Set([...(previous?.addresses ?? []), ...(node.addresses ?? [])])].sort() } : {}),
      ...(previous?.sourceIds || node.sourceIds ? { sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...(node.sourceIds ?? [])])].sort() } : {}) });
    return node.id;
  }

  edge(edge: Omit<GraphEdge, "id">): string {
    const id = `e${digest(JSON.stringify([edge.from, edge.to, edge.kind, edge.phase, edge.evidence ?? null]))}`;
    this.edges.set(id, { ...edge, id });
    return id;
  }
}

function cycles(nodes: GraphNode[], edges: GraphEdge[], kind: GraphCycle["kind"]): GraphCycle[] {
  const relation = kind === "registry" ? "registry-dependency" : "file-import";
  const selected = edges.filter((edge) => edge.kind === relation && edge.status === "resolved");
  const forward = new Map(nodes.map(({ id }) => [id, [] as string[]]));
  const reverse = new Map(nodes.map(({ id }) => [id, [] as string[]]));
  for (const edge of selected) { forward.get(edge.from)!.push(edge.to); reverse.get(edge.to)!.push(edge.from); }
  const visited = new Set<string>();
  const order: string[] = [];
  // Iterative Kosaraju traversal also handles long dependency chains without
  // consuming the JavaScript call stack.
  for (const { id } of nodes) {
    if (visited.has(id)) continue;
    const stack: { id: string; finish: boolean }[] = [{ id, finish: false }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.finish) { order.push(current.id); continue; }
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      stack.push({ id: current.id, finish: true });
      for (const next of forward.get(current.id)!) if (!visited.has(next)) stack.push({ id: next, finish: false });
    }
  }
  const assigned = new Set<string>();
  const result: GraphCycle[] = [];
  for (const id of order.reverse()) {
    if (assigned.has(id)) continue;
    const component = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      if (assigned.has(next)) continue;
      assigned.add(next); component.add(next);
      stack.push(...reverse.get(next)!);
    }
    if (component.size === 1 && !forward.get(id)!.includes(id)) continue;
    result.push({ kind, nodes: [...component].sort(), edges: selected.filter(({ from, to }) => component.has(from) && component.has(to)).map(({ id }) => id).sort() });
  }
  return result.sort((a, b) => a.nodes[0]!.localeCompare(b.nodes[0]!));
}

type GraphInput = Omit<DependencyGraph, "graphVersion" | "snapshotId" | "nodes" | "edges" | "dependencies" | "dependents" | "cycles" | "counts" | "complete">;

export function finishGraph(store: GraphStore, input: GraphInput): DependencyGraph {
  const nodes = [...store.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const initialEdges = [...store.edges.values()].map((edge) => ({ ...edge,
    status: store.nodes.get(edge.to)?.state === "unresolved" ? "unresolved" as const : edge.status,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const diagnostics = [...new Map(input.diagnostics.map((value) => [JSON.stringify(value), value])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const graphCycles = [...cycles(nodes, initialEdges, "registry"), ...cycles(nodes, initialEdges, "source")];
  const cycleEdges = new Set(graphCycles.flatMap(({ edges }) => edges));
  const edges = initialEdges.map((edge) => ({ ...edge, ...(cycleEdges.has(edge.id) ? { cycle: true } : {}) }));
  const dependencies: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const dependents: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const { id } of nodes) { dependencies[id] = []; dependents[id] = []; }
  for (const { from, to } of edges) {
    if (!dependencies[from] || !dependents[to]) throw new CliError("GRAPH_INVALID", "Graph edge refers to a missing node.");
    dependencies[from].push(to); dependents[to].push(from);
  }
  for (const index of [dependencies, dependents]) for (const id of Object.keys(index)) index[id] = [...new Set(index[id])].sort();
  const complete = input.coverage.inventory && input.coverage.registry && input.coverage.source && !diagnostics.some(({ severity }) => severity === "error");
  const snapshotId = digest(JSON.stringify([input.scope, input.projectRoot, input.scopes, input.seeds, nodes, edges, input.coverage, diagnostics]));
  return { ...input, diagnostics, graphVersion: 1, snapshotId, nodes, edges, cycles: graphCycles, dependencies, dependents, complete,
    counts: {
      items: nodes.filter(({ kind }) => kind === "item").length, localFiles: nodes.filter(({ kind }) => kind === "file").length,
      packages: nodes.filter(({ kind }) => kind === "package").length, resources: nodes.filter(({ kind }) => kind === "resource").length,
      unresolved: nodes.filter(({ state }) => state === "unresolved").length, edges: edges.length, cycles: graphCycles.length,
    } };
}

export function graphNeighbors(graph: DependencyGraph, id: string, options: { direction?: "dependencies" | "dependents"; transitive?: boolean; kinds?: EdgeKind[] } = {}): string[] {
  if (!graph.nodes.some((node) => node.id === id)) throw new CliError("GRAPH_NODE_NOT_FOUND", "Graph node does not exist.");
  const reverse = options.direction === "dependents";
  const index = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (options.kinds && !options.kinds.includes(edge.kind)) continue;
    const from = reverse ? edge.to : edge.from;
    const set = index.get(from) ?? new Set<string>();
    set.add(reverse ? edge.from : edge.to); index.set(from, set);
  }
  const result = new Set<string>();
  const pending = [id];
  for (let offset = 0; offset < pending.length; offset++) {
    for (const next of index.get(pending[offset]!) ?? []) {
      if (next === id || result.has(next)) continue;
      result.add(next);
      if (options.transitive) pending.push(next);
    }
  }
  return [...result].sort();
}
