import { CliError } from "../core/errors.js";
import { buildDependencyGraph } from "../graph/build.js";
import { formatMermaid, selectGraph } from "../graph/export.js";
import type { DependencyGraph } from "../graph/types.js";
import type { InventoryCliOptions } from "./inventory.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";

export interface GraphCliOptions extends InventoryCliOptions {
  scope: "installed" | "catalog";
  maxItems: string;
  maxFiles: string;
  mermaid?: boolean;
  focus?: string;
  reverse?: boolean;
  transitive?: boolean;
}

export function formatGraph(graph: DependencyGraph): string {
  const counts = graph.counts;
  const labels = new Map(graph.nodes.map(({ id, label }) => [id, label]));
  const lines = [
    `Project: ${graph.projectRoot}`, `Graph scope: ${graph.scope}`, `Snapshot: ${graph.snapshotId}`,
    `Nodes: ${counts.items} item bindings, ${counts.localFiles} local files, ${counts.packages} package requests, ${counts.resources} retained resources`,
    `Edges: ${counts.edges}; unresolved nodes: ${counts.unresolved}; cycles: ${counts.cycles}`,
    `Coverage: inventory=${graph.coverage.inventory}, registry=${graph.coverage.registry}, source=${graph.coverage.source}; usage=${graph.coverage.usage}`,
  ];
  if (graph.view) {
    lines.push(`View: ${labels.get(graph.view.focus)}; ${graph.view.direction}; ${graph.view.transitive ? "transitive" : "direct"}`);
    for (const edge of graph.edges) lines.push(`${labels.get(edge.from)} -> ${labels.get(edge.to)} [${edge.kind}, ${edge.phase}, ${edge.status}]`);
  }
  for (const cycle of graph.cycles) lines.push(`${cycle.kind} cycle: ${cycle.nodes.map((id) => labels.get(id)).join(", ")}`);
  for (const source of graph.sources) if (source.status !== "ready") lines.push(`${source.source.namespace} [${source.source.scope}]: ${source.status}`);
  for (const diagnostic of graph.diagnostics) lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? ` [${diagnostic.path}]` : ""}`);
  lines.push("Registry declarations and observed imports are separate relations. Usage and cleanup eligibility are not classified.");
  lines.push(graph.complete ? "Graph complete within the reported scopes and supported reference formats." : "Graph incomplete. Unresolved relationships and healthy results are retained.");
  return lines.join("\n");
}

export async function runGraph(options: GraphCliOptions, outputOptions: OutputOptions): Promise<void> {
  if ((!options.focus && (options.reverse || options.transitive)) || (!options.cache && options.cacheDir)) {
    throw new CliError("INVALID_OPTIONS", "Reverse/transitive views require --focus; choose either --cache-dir or --no-cache.");
  }
  let graph = await buildDependencyGraph({
    cwd: options.cwd, workspace: options.workspace, items: options.item, offline: options.offline, refresh: options.refresh,
    cacheDir: options.cache ? options.cacheDir : false, concurrency: Number(options.concurrency), timeoutMs: Number(options.timeout),
    scope: options.scope, maxItems: Number(options.maxItems), maxFiles: Number(options.maxFiles),
  });
  if (options.focus) graph = selectGraph(graph, options.focus, { direction: options.reverse ? "dependents" : "dependencies", transitive: options.transitive });
  const mermaid = options.mermaid ? formatMermaid(graph) : undefined;
  const data = mermaid ? { ...graph, mermaid } : graph;
  const mode = getOutputMode(outputOptions);
  if (!graph.complete) {
    // Piped diagrams remain valid artifacts, with diagnostics on stderr and exit 2.
    if (mermaid && mode !== "json") {
      process.stdout.write(mermaid);
      throw new CliError("GRAPH_INCOMPLETE", formatGraph(graph));
    }
    throw new CliError("GRAPH_INCOMPLETE", mode === "json" ? "Dependency graph coverage is incomplete. See graph diagnostics and unresolved edges." : formatGraph(graph), { graph: data });
  }
  new CliOutput(mode).success(data, mermaid ?? formatGraph(graph));
}
