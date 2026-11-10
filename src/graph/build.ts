import { CliError } from "../core/errors.js";
import { dirname } from "node:path";
import { findProject } from "../project/files.js";
import { createInventorySession, type InventoryOptions } from "../inventory/build.js";
import { fileId, finishGraph, GraphStore } from "./model.js";
import { registryClosure } from "./registry.js";
import { sourceGraph } from "./source.js";
import type { DependencyGraph } from "./types.js";

export interface GraphOptions extends InventoryOptions {
  scope?: "installed" | "catalog";
  maxItems?: number;
  maxFiles?: number;
}

export async function buildDependencyGraph(options: GraphOptions = {}): Promise<DependencyGraph> {
  const scope = options.scope ?? "installed";
  const maxItems = options.maxItems ?? 2000;
  const maxFiles = options.maxFiles ?? 20_000;
  if (!["installed", "catalog"].includes(scope) || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10_000 ||
    !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) {
    throw new CliError("INVALID_OPTIONS", "Choose installed/catalog scope, an item limit of 1-10000, and a file limit of 1-100000.");
  }
  const requested = (options.items ?? []).map((value) => {
    if (/^https?:\/\//i.test(value) || /^@[\w-]+\/.+/.test(value)) return value;
    if (/^[\w-]+$/.test(value)) return `@shadcn/${value}`;
    throw new CliError("INVALID_ARGUMENT", "Graph seeds must be @namespace/item addresses, official bare names, or HTTP(S) item URLs.");
  });
  const session = await createInventorySession({ ...options, items: requested.filter((value) => value.startsWith("@")) });
  const store = new GraphStore();
  for (const file of session.report.files) store.node({ id: fileId(file.path), kind: "file", label: file.path, path: file.path,
    scope: session.report.scopes.find((root) => file.path.startsWith(root)) ?? session.report.projectRoot,
    state: "present", contentHash: file.contentHash, originConfidence: file.origin });
  const registry = await registryClosure(session, store, { scope, items: requested, maxItems, concurrency: options.concurrency ?? 4, offline: options.offline });
  // Available-only destinations for other frameworks do not invalidate a graph
  // which never selected them. Detail failures and potentially local candidates
  // still block coverage; selected catalog manifests are checked by the closure.
  const relevantItems = session.report.items.filter((item) => item.manifest !== "catalog" || item.mappedFiles.some(({ present }) => present));
  const inventoryComplete = !session.report.diagnostics.some(({ severity }) => severity === "error") &&
    session.report.sources.every(({ status }) => status === "ready") && relevantItems.every((item) => item.manifest !== "error" && item.manifest !== "stale" && !item.diagnostics.some(({ severity }) => severity === "error"));
  const unselectedMappings = session.report.items.filter((item) => item.manifest === "catalog" && !item.mappedFiles.some(({ present }) => present) &&
    item.diagnostics.some(({ severity }) => severity === "error") && (scope === "installed" || (requested.length > 0 && !requested.includes(item.qualifiedName))));
  const workspaceRoots = session.selected.workspace ? [session.selected.workspace.root, ...session.selected.workspace.packages.map(({ root }) => root)] : session.report.scopes;
  const roots = options.workspace ? [...new Set([...workspaceRoots, ...session.report.scopes])] : session.report.scopes;
  const source = sourceGraph(store, session.selected, roots, { maxFiles, signal: options.signal });
  for (const node of store.nodes.values()) {
    if (node.kind === "file" && node.path) {
      try { store.node({ ...node, scope: findProject(dirname(node.path)).root }); } catch { /* Read failures are already retained as source diagnostics. */ }
    } else if (node.kind === "item") {
      const name = node.addresses?.filter((value) => value.startsWith("@")).sort()[0];
      if (name) store.node({ ...node, label: name });
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const edge of store.edges.values()) {
    if (edge.kind !== "item-file-candidate") continue;
    const ownership = store.nodes.get(edge.from)?.ownershipKey ?? edge.from;
    const candidates = owners.get(edge.to) ?? new Set<string>();
    candidates.add(ownership); owners.set(edge.to, candidates);
  }
  for (const [id, candidates] of owners) store.node({ ...store.nodes.get(id)!, originConfidence: candidates.size > 1 ? "ambiguous" : "candidate" });
  for (const edge of store.edges.values()) if (edge.kind === "item-file-candidate" && (owners.get(edge.to)?.size ?? 0) > 1) {
    store.node({ ...store.nodes.get(edge.from)!, originConfidence: "ambiguous" });
  }
  return finishGraph(store, {
    scope, projectRoot: session.report.projectRoot, scopes: [...new Set([...session.report.scopes, ...source.scopes])].sort(), seeds: registry.seeds,
    sources: session.report.sources, registrySources: [...new Map([...session.sources, ...registry.sources].map(({ descriptor }) => [descriptor.id, descriptor])).values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [...session.report.diagnostics, ...session.report.sources.flatMap(({ diagnostics }) => diagnostics),
      ...relevantItems.flatMap((item) => item.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${item.qualifiedName}: ${diagnostic.message}` }))),
      ...(unselectedMappings.length ? [{ code: "GRAPH_CATALOG_MAPPING_UNSELECTED", severity: "warning" as const,
        message: `${unselectedMappings.length} available-only catalog entries have destination diagnostics outside the selected graph. Inspect inventory for their mapping details.` }] : []),
      ...registry.diagnostics, ...source.diagnostics],
    coverage: { inventory: inventoryComplete, registry: registry.complete, source: source.complete, usage: "not-analyzed" },
  });
}
