import { CliError } from "../core/errors.js";
import { makeItem, type createInventorySession } from "../inventory/build.js";
import type { InventoryItem } from "../inventory/types.js";
import type { Diagnostic, ProjectContext } from "../project/types.js";
import { mapLimit } from "../registry/client.js";
import { RegistrySource, digest } from "../registry/source.js";
import type { RegistryReference } from "../registry/types.js";
import { canonicalJSON } from "../core/hash.js";
import { fileId, GraphStore, nodeId } from "./model.js";

export type InventorySession = Awaited<ReturnType<typeof createInventorySession>>;
interface Address { id: string; source: RegistrySource; name: string; context: ProjectContext; display: string }

function address(reference: string, context: ProjectContext, sources: RegistrySource[]): Address {
  if (/^https?:\/\//i.test(reference)) {
    const source = new RegistrySource("@url", { url: reference }, context.projectRoot, "URL dependency", "direct", {}, true);
    const id = nodeId("item", context.projectRoot, source.request("manifest").key);
    return { id, source, name: "manifest", context, display: `URL item ${digest(reference).slice(0, 12)}` };
  }
  const qualified = /^(@[\w-]+)\/(.+)$/.exec(reference);
  const bare = /^[\w-]+$/.test(reference);
  if (!qualified && !bare) throw new CliError("REGISTRY_ADDRESS_UNSUPPORTED", "Registry dependency address is unsupported; use a configured namespace, an official bare name, or an HTTP(S) item URL.");
  const namespace = qualified ? qualified[1]! : "@shadcn";
  const name = qualified ? qualified[2]! : reference;
  const source = sources.find(({ descriptor }) => descriptor.scope === context.projectRoot && descriptor.namespace === namespace);
  if (!source) throw new CliError("REGISTRY_NOT_CONFIGURED", "Dependency namespace is not configured in its owning workspace.");
  return { id: nodeId("item", context.projectRoot, source.request(name).key), source, name, context, display: `${namespace}/${name}` };
}

export function packageName(specification: string): string | null {
  const match = /^(?:(@[a-z\d._-]+\/[a-z\d._-]+)|([a-z\d._-]+))(?:@[^\s]+)?$/i.exec(specification);
  return match ? match[1] ?? match[2]! : null;
}

export function addDeclaredPackages(store: GraphStore, from: string, item: InventoryItem): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [phase, specifications] of [["runtime", item.dependencies], ["development", item.devDependencies]] as const) {
    for (const specification of specifications) {
      const name = packageName(specification);
      const id = nodeId(name ? "package" : "unresolved-package", item.scope, name ?? specification);
      store.node({ id, kind: name ? "package" : "unresolved", label: name ?? "Unsupported package specification", scope: item.scope, state: name ? "unknown" : "unresolved", ...(name ? { packageName: name } : {}) });
      store.edge({ from, to: id, kind: "declared-package", status: name ? "resolved" : "unresolved", phase: "declaration", evidence: { specification, syntax: phase } });
      if (!name) diagnostics.push({ code: "GRAPH_PACKAGE_SPEC_UNSUPPORTED", severity: "error", message: "Registry package specification cannot be classified as a package name/version request.", path: item.scope });
    }
  }
  return diagnostics;
}

export async function registryClosure(session: InventorySession, store: GraphStore, options: {
  scope: "installed" | "catalog"; items?: string[]; maxItems: number; concurrency: number; offline?: boolean;
}): Promise<{ seeds: string[]; diagnostics: Diagnostic[]; complete: boolean; sources: RegistrySource[] }> {
  const diagnostics: Diagnostic[] = [];
  const seeds = new Set<string>();
  const visited = new Set<string>();
  const pending: Address[] = [];
  const extraSources = new Map<string, RegistrySource>();
  const aliases = new Map<string, { addresses: Set<string>; sources: Set<string> }>();
  let complete = true;
  const fail = (from: string | undefined, reference: RegistryReference | { id: string; reference: string }, context: ProjectContext, error: unknown): void => {
    complete = false;
    const code = error instanceof CliError ? error.code : "REGISTRY_GRAPH_FAILED";
    const id = nodeId("unresolved-registry", context.projectRoot, reference.id);
    store.node({ id, kind: "unresolved", label: code, scope: context.projectRoot, state: "unresolved" });
    if (from) store.edge({ from, to: id, kind: "registry-dependency", phase: "declaration", status: "unresolved", evidence: { reference: reference.reference } });
    else seeds.add(id);
    diagnostics.push({ code, severity: "error", message: error instanceof CliError ? error.message : "Cannot resolve registry dependency.", path: context.projectRoot });
  };
  const enqueue = (entry: Address): string => {
    if (!visited.has(entry.id) && visited.size >= options.maxItems) {
      const id = nodeId("registry-item-limit", entry.context.projectRoot);
      store.node({ id, kind: "unresolved", label: "Registry item limit", scope: entry.context.projectRoot, state: "unresolved" });
      diagnostics.push({ code: "GRAPH_ITEM_LIMIT", severity: "error", message: "Registry dependency closure exceeds the configured item limit.", path: entry.context.projectRoot });
      complete = false; return id;
    }
    const labels = aliases.get(entry.id) ?? { addresses: new Set<string>(), sources: new Set<string>() };
    labels.addresses.add(entry.display); labels.sources.add(entry.source.descriptor.id); aliases.set(entry.id, labels);
    extraSources.set(entry.source.descriptor.id, entry.source);
    const existing = store.nodes.get(entry.id);
    if (existing) store.node({ ...existing, addresses: [...labels.addresses].sort(), sourceIds: [...labels.sources].sort() });
    if (visited.has(entry.id)) return entry.id;
    visited.add(entry.id);
    pending.push(entry);
    return entry.id;
  };
  const chosen = options.items?.length ? session.report.items.filter((item) => item.scope === session.report.projectRoot && options.items!.some((value) => (value.startsWith("@") ? value : `@shadcn/${value}`) === item.qualifiedName)) : session.report.items;
  for (const item of chosen) {
    if (options.scope === "installed" && !item.mappedFiles.some(({ present }) => present)) {
      if (options.items?.length) fail(undefined, { id: digest(item.qualifiedName), reference: item.qualifiedName }, session.contexts.get(item.scope)!, new CliError("GRAPH_ITEM_NOT_LOCAL", "Requested item has no observed local files. Use catalog scope to inspect available items."));
      continue;
    }
    const entry = address(item.qualifiedName, session.contexts.get(item.scope)!, session.sources);
    seeds.add(enqueue(entry));
  }
  for (const value of options.items ?? []) if (/^https?:\/\//i.test(value)) {
    const context = session.contexts.get(session.report.projectRoot);
    if (!context) throw new CliError("GRAPH_SCOPE_REQUIRED", "Choose a configured --cwd package for explicit URL items.");
    try { const entry = address(value, context, session.sources); seeds.add(enqueue(entry)); } catch (error) { fail(undefined, { id: digest(value), reference: "URL item" }, context, error); }
  }
  for (let offset = 0; offset < pending.length;) {
    const batch = pending.slice(offset, offset + options.concurrency); offset += batch.length;
    // Fetch concurrently, then apply results in queue order so limits and graph
    // identities do not depend on which server happens to respond first.
    const results = await mapLimit(batch, options.concurrency, async (entry) => {
      try {
        let fetched = await session.client.fetch(entry.source, entry.name, "item");
        let recoveryFailed = false;
        if (fetched.document.items[0]!.registryDependencies.some((reference) => reference.requiresOriginal && !entry.source.originalReference(reference.id)) && !options.offline) {
          try { fetched = await session.client.recoverReferences(entry.source, entry.name); } catch { recoveryFailed = true; }
        }
        return { entry, fetched, recoveryFailed };
      } catch (error) { return { entry, error }; }
    });
    for (const result of results) {
      const { entry } = result;
      const { source, context, id } = entry;
      try {
        if ("error" in result) throw result.error;
        const { fetched } = result;
        const detail = fetched.document.items[0]!;
        if (result.recoveryFailed) {
          diagnostics.push({ code: "REGISTRY_REFERENCE_RECOVERY_FAILED", severity: "error", message: "Could not recover opaque dependency addresses from a fresh parent manifest.", path: context.projectRoot }); complete = false;
        }
        const item = makeItem(detail, source, context, false, fetched.cache === "stale-cache" ? "stale" : "fetched");
        if (fetched.cache === "stale-cache") complete = false;
        if (fetched.diagnostic) diagnostics.push(fetched.diagnostic);
        diagnostics.push(...item.diagnostics);
        store.node({ id, kind: "item", label: source.direct ? detail.name : entry.display, addresses: [...aliases.get(id)!.addresses].sort(), sourceIds: [...aliases.get(id)!.sources].sort(), scope: context.projectRoot,
          manifestHash: digest(canonicalJSON(detail)), fetch: { cache: fetched.cache, fetchedAt: fetched.fetchedAt },
          ownershipKey: digest(JSON.stringify([source.request(entry.name).key, item.mappedFiles.map(({ path }) => path).filter(Boolean).sort()])),
          state: item.presence, itemType: item.type, manifest: item.manifest === "stale" ? "stale" : "fetched", originConfidence: item.originConfidence });
        if (options.scope === "installed" && seeds.has(id) && source.direct && !item.mappedFiles.some(({ present }) => present)) {
          diagnostics.push({ code: "GRAPH_ITEM_NOT_LOCAL", severity: "error", message: "URL seed has no observed local files; use catalog scope.", path: context.projectRoot }); complete = false;
        }
        for (const file of item.mappedFiles) {
          if (!file.present || !file.path) continue;
          const target = fileId(file.path);
          store.node({ id: target, kind: "file", label: file.path, path: file.path, scope: context.projectRoot, state: "present", contentHash: file.contentHash });
          store.edge({ from: id, to: target, kind: "item-file-candidate", phase: "declaration", status: "resolved", evidence: { reference: file.registryPath, syntax: file.mapping } });
        }
        diagnostics.push(...addDeclaredPackages(store, id, item));
        for (const resource of detail.resources ?? []) {
          const target = nodeId("resource", context.projectRoot, resource.kind, resource.fingerprint);
          store.node({ id: target, kind: "resource", label: `${resource.kind} declaration`, scope: context.projectRoot, state: "unknown", resourceKind: resource.kind, retained: true });
          store.edge({ from: id, to: target, kind: "item-resource", phase: "declaration", status: "resolved" });
        }
        for (const reference of detail.registryDependencies) {
          try {
            const original = source.originalReference(reference.id) ?? (reference.requiresOriginal ? undefined : reference.reference);
            if (!original) throw new CliError("REGISTRY_REFERENCE_UNAVAILABLE", "Opaque registry dependency cannot be reconstructed from this offline/cache snapshot.");
            const next = address(original, context, session.sources);
            const to = enqueue(next);
            store.edge({ from: id, to, kind: "registry-dependency", phase: "declaration", status: to === next.id ? "resolved" : "unresolved", evidence: { reference: reference.reference } });
          } catch (error) { fail(id, reference, context, error); }
        }
      } catch (error) {
        complete = false;
        store.node({ id, kind: "item", label: entry.display, addresses: [entry.display], sourceIds: [source.descriptor.id], scope: context.projectRoot, state: "unresolved", manifest: "error" });
        diagnostics.push({ code: error instanceof CliError ? error.code : "REGISTRY_FETCH_FAILED", severity: "error", message: error instanceof CliError ? error.message : "Cannot fetch graph item manifest.", path: context.projectRoot });
      }
    }
  }
  return { seeds: [...seeds].sort(), diagnostics, complete: complete && !diagnostics.some(({ severity }) => severity === "error"), sources: [...extraSources.values()] };
}
