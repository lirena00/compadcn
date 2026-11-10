import { canonicalJSON, digest } from "../core/hash.js";
import type { DependencyGraph, GraphNode } from "../graph/types.js";
import type { KnipAnalysis, RootPolicy } from "../analysis/types.js";
import { proofFor, reachable } from "../analysis/reachability.js";
import type { FileFinding, ItemFinding, UsageState } from "./types.js";

export function classifyUsage(graph: DependencyGraph, policy: RootPolicy, analysis: KnipAnalysis, workspaceComplete: boolean) {
  const runtime = reachable(graph, policy.roots.filter(({ role }) => role === "runtime"), true);
  const all = reachable(graph, policy.roots.filter(({ role }) => role !== "public"), false);
  const publicReach = reachable(graph, policy.roots.filter(({ role }) => role === "public"), false);
  const known = new Set(policy.scopes.flatMap(({ files }) => files));
  const publicScopes = new Set(policy.scopes.filter(({ publicContract }) => publicContract).map(({ root }) => root));
  const allUnused = new Set(analysis.all.unusedFiles);
  const productionUnused = new Set(analysis.production.unusedFiles);
  const reliable = graph.complete && policy.complete && analysis.complete && workspaceComplete;
  const incoming = new Map<string, DependencyGraph["edges"]>();
  const ownedFiles = new Map<string, string[]>();
  const resourceOwners = new Set<string>();
  const registryDependents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "item-file-candidate") {
      const rows = ownedFiles.get(edge.from) ?? []; rows.push(edge.to); ownedFiles.set(edge.from, rows);
    }
    if (edge.kind === "item-resource") resourceOwners.add(edge.from);
    if (edge.kind === "registry-dependency") {
      const rows = registryDependents.get(edge.to) ?? []; rows.push(edge.from); registryDependents.set(edge.to, rows);
    }
    if (edge.kind !== "file-import") continue;
    const rows = incoming.get(edge.to) ?? []; rows.push(edge); incoming.set(edge.to, rows);
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const owners = new Set([...ownedFiles.values()].flat());
  const files: FileFinding[] = graph.nodes.filter((node) => node.kind === "file" && node.path && (node.originConfidence !== undefined || owners.has(node.id))).map((node) => {
    const path = node.path!;
    const nativeAllUnused = allUnused.has(path), nativeProductionUnused = productionUnused.has(path);
    let usage: UsageState = "unknown";
    const reasons: string[] = [];
    const proof = proofFor(node.id, runtime.has(node.id) ? runtime : all, graph, nodes);
    const publicFile = publicScopes.has(node.scope) || publicReach.has(node.id);
    if (!policy.complete) reasons.push("ENTRY_POLICY_INCOMPLETE");
    else if (runtime.has(node.id)) {
      if ((analysis.all.complete && nativeAllUnused) || (analysis.production.complete && nativeProductionUnused)) reasons.push("ANALYZER_DISAGREEMENT");
      else { usage = "runtime"; reasons.push("RUNTIME_REFERENCE_PATH"); }
    } else if (publicFile) reasons.push("PUBLIC_API_RETAINED");
    else if (node.retained || !known.has(path)) reasons.push("RESOURCE_USAGE_UNKNOWN");
    else if (reliable && all.has(node.id)) {
      // Knip may exclude development entry files from its production project
      // set entirely. Absence from its unused list is not a runtime-use claim.
      if (nativeAllUnused || (!nativeProductionUnused && !proof?.typeOnly && proof?.role !== "development")) reasons.push("ANALYZER_DISAGREEMENT");
      else { usage = "development-only"; reasons.push(proof?.typeOnly ? "TYPE_ONLY_REFERENCE" : "DEVELOPMENT_REFERENCE_PATH"); }
    } else if (reliable && nativeAllUnused && nativeProductionUnused) { usage = "unused-candidate"; reasons.push("ANALYZERS_AGREE_UNREACHABLE"); }
    else if (reliable) reasons.push("ANALYZER_DISAGREEMENT");
    else reasons.push("ANALYSIS_INCOMPLETE");
    const consumers = (incoming.get(node.id) ?? []).flatMap((edge) => {
      const from = nodes.get(edge.from);
      return from?.path ? [{ path: from.path, line: edge.evidence?.line, column: edge.evidence?.column, phase: edge.phase }] : [];
    }).sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
    return { id: node.id, path, scope: node.scope, usage, reasons, unmapped: !owners.has(node.id),
      knip: { allUnused: nativeAllUnused, productionUnused: nativeProductionUnused, analyzed: known.has(path) && analysis.complete },
      ...(proof ? { proof } : {}), consumers: consumers.slice(0, 12), consumerCount: consumers.length };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const byFile = new Map(files.map((file) => [file.id, file]));
  const groups = new Map<string, { nodes: GraphNode[]; files: Set<string> }>();
  for (const node of graph.nodes) {
    if (node.kind !== "item") continue;
    const owned = (ownedFiles.get(node.id) ?? []).sort();
    if (!owned.length) continue;
    const id = `item:${digest(canonicalJSON(owned))}`;
    const group = groups.get(id) ?? { nodes: [], files: new Set<string>() };
    group.nodes.push(node); for (const file of owned) group.files.add(file); groups.set(id, group);
  }
  const items: ItemFinding[] = [...groups].map(([id, group]): ItemFinding => {
    const associated = [...group.files].map((file) => byFile.get(file)!);
    const addresses = [...new Set(group.nodes.flatMap(({ addresses, label }) => addresses ?? [label]))].sort();
    const scopes = [...new Set(group.nodes.map(({ scope }) => scope))].sort();
    const resources = group.nodes.some(({ id }) => resourceOwners.has(id));
    const partial = group.nodes.some(({ state }) => state !== "present");
    const retention = ["OWNERSHIP_UNVERIFIED", ...(group.nodes.some(({ originConfidence }) => originConfidence === "ambiguous") ? ["OWNERSHIP_AMBIGUOUS"] : []),
      ...(resources ? ["SHARED_RESOURCE_RETAINED"] : []), ...(partial ? ["PARTIAL_ITEM"] : []),
      ...(associated.some(({ scope }) => publicScopes.has(scope)) ? ["PUBLIC_API_RETAINED"] : []), ...(!reliable ? ["ANALYSIS_INCOMPLETE"] : [])];
    let usage: UsageState = "unknown";
    if (associated.some(({ usage }) => usage === "runtime")) usage = "runtime";
    else if (!partial && !resources && associated.every(({ usage }) => usage !== "unknown")) usage = associated.some(({ usage }) => usage === "development-only") ? "development-only" : "unused-candidate";
    const reasons = [...new Set(associated.flatMap(({ reasons }) => reasons))].sort();
    if (resources && usage === "unknown") reasons.push("RESOURCE_USAGE_UNKNOWN");
    if (partial) reasons.push("PARTIAL_ITEM");
    const proof = associated.find((file) => file.usage === usage)?.proof ?? associated.find(({ proof }) => proof)?.proof;
    return { id, nodeIds: group.nodes.map(({ id }) => id).sort(), label: addresses[0]!, addresses, scopes, files: [...group.files].sort(), usage, reasons: [...new Set(reasons)], retention,
      ...(proof ? { proof } : {}), declaredDependents: [], cleanup: { eligible: false, blockers: [...retention, "CLEANUP_PLAN_REQUIRED"] } };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const byNode = new Map(items.flatMap((item) => item.nodeIds.map((id) => [id, item] as const)));
  for (const item of items) {
    const dependents = new Map(item.nodeIds.flatMap((id) => registryDependents.get(id) ?? []).flatMap((id) => {
      const value = byNode.get(id); return value && value.id !== item.id ? [[value.id, value] as const] : [];
    }));
    item.declaredDependents = [...dependents.values()].sort((a,b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)).map(({ id, label, usage }) => ({ id, label, usage }));
    if (item.declaredDependents.some(({ usage }) => usage !== "unused-candidate")) {
      item.retention.push("REGISTRY_DEPENDENT_RETAINED"); item.cleanup.blockers.push("REGISTRY_DEPENDENT_RETAINED");
    }
  }
  return { files, items, runtime, all, reliable };
}
