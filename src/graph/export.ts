import { relative, resolve } from "node:path";
import { CliError } from "../core/errors.js";
import { finishGraph, GraphStore, graphNeighbors, nodeId } from "./model.js";
import type { DependencyGraph } from "./types.js";

export function selectGraph(graph: DependencyGraph, reference: string, options: { direction?: "dependencies" | "dependents"; transitive?: boolean } = {}): DependencyGraph {
  const path = resolve(graph.projectRoot, reference);
  const matches = graph.nodes.filter((node) => node.id === reference || node.label === reference || node.addresses?.includes(reference) || node.path === path || node.packageName === reference);
  if (!matches.length) throw new CliError("GRAPH_NODE_NOT_FOUND", "No graph node matches this address, path, label, or ID.");
  if (matches.length > 1) throw new CliError("GRAPH_NODE_AMBIGUOUS", "Graph reference matches multiple nodes; select an opaque node ID.", {
    choices: matches.map(({ id, label, scope }) => ({ id, label, scope })),
  });
  const focus = matches[0]!.id;
  const selected = new Set([focus, ...graphNeighbors(graph, focus, options)]);
  const store = new GraphStore();
  for (const node of graph.nodes) if (selected.has(node.id)) store.node(node);
  for (const edge of graph.edges) if (selected.has(edge.from) && selected.has(edge.to)) store.edge(edge);
  return finishGraph(store, {
    scope: graph.scope, projectRoot: graph.projectRoot, scopes: graph.scopes, seeds: graph.seeds.filter((id) => selected.has(id)),
    sources: graph.sources, registrySources: graph.registrySources, diagnostics: graph.diagnostics, coverage: graph.coverage,
    view: { baseSnapshotId: graph.snapshotId, focus, direction: options.direction ?? "dependencies", transitive: options.transitive ?? false },
  });
}

function escapeLabel(value: string): string {
  return [...value].map((character) => /[\w .\/@:+-]/.test(character) ? character : /\s/.test(character) ? " " : `#${character.codePointAt(0)};`).join("");
}

export function formatMermaid(graph: DependencyGraph): string {
  const ids = new Map(graph.nodes.map(({ id }) => [id, nodeId("mermaid", id)]));
  const snapshot = graph.snapshotId.replace(/[^a-f0-9]/g, "");
  const lines = ["flowchart LR", `%% graphVersion=1 scope=${graph.scope === "catalog" ? "catalog" : "installed"} complete=${!!graph.complete} snapshot=${snapshot}`];
  for (const node of graph.nodes) {
    const label = node.path ? relative(graph.projectRoot, node.path).replaceAll("\\", "/") || "." : node.label;
    lines.push(`  ${ids.get(node.id)}["${escapeLabel(`${node.kind}: ${label} (${node.state})`)}"]`);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new CliError("GRAPH_INVALID", "Mermaid edge refers to a missing node.");
    const label = `${edge.kind} / ${edge.phase}${edge.status === "unresolved" ? " / unresolved" : ""}${edge.cycle ? " / cycle" : ""}`;
    lines.push(`  ${ids.get(edge.from)} ${edge.status === "unresolved" ? "-.->" : "-->"}|"${escapeLabel(label)}"| ${ids.get(edge.to)}`);
  }
  return lines.join("\n") + "\n";
}
