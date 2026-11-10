import { CliError } from "../core/errors.js";
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
  const roots = options.workspace ? session.selected.workspace?.packages.map(({ root }) => root) ?? session.report.scopes : session.report.scopes;
  const source = sourceGraph(store, session.selected, roots, { maxFiles, signal: options.signal });
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
    diagnostics: [...session.report.diagnostics, ...session.report.sources.flatMap(({ diagnostics }) => diagnostics), ...registry.diagnostics, ...source.diagnostics],
    coverage: { inventory: session.report.complete, registry: registry.complete, source: source.complete, usage: "not-analyzed" },
  });
}
