import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../core/errors.js";
import { discoverProject } from "../project/discover.js";
import { isObject, isWithin, readObject } from "../project/files.js";
import type { Diagnostic, ProjectContext } from "../project/types.js";
import { RegistryClient, mapLimit, type RegistryClientOptions } from "../registry/client.js";
import { digest, loadRegistrySources, type RegistrySource } from "../registry/source.js";
import type { RemoteItem } from "../registry/types.js";
import { localNames, mapFile, scanLocalFiles } from "./files.js";
import type { InventoryItem, InventoryReport, LocalFile } from "./types.js";

export interface InventoryOptions extends RegistryClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  workspace?: boolean;
  items?: string[];
  concurrency?: number;
}

function configured(root: string): boolean {
  return existsSync(join(root, "components.json")) || isObject(readObject(join(root, "package.json"), "PACKAGE_JSON_INVALID").registries);
}

function scopes(project: ProjectContext, workspace: boolean): string[] {
  const packages = project.workspace?.packages ?? [];
  if (workspace) {
    const roots = packages.filter(({ root }) => configured(root)).map(({ root }) => root);
    return roots.length ? roots : [project.projectRoot];
  }
  const roots = new Set([project.projectRoot]);
  for (const alias of Object.values(project.components?.resolvedAliases ?? {})) {
    const owner = [...packages].sort((a, b) => b.root.length - a.root.length).find(({ root }) => isWithin(root, alias.path));
    if (owner && owner.root !== project.projectRoot && configured(owner.root)) roots.add(owner.root);
  }
  return [...roots];
}

export function makeItem(item: RemoteItem, source: RegistrySource, context: ProjectContext, inCatalog: boolean, manifest: InventoryItem["manifest"]): InventoryItem {
  const mappedFiles = item.files.map((file) => mapFile(file, context));
  const diagnostics = mappedFiles.flatMap((file) => file.diagnostic ? [file.diagnostic] : []);
  const resolved = mappedFiles.flatMap(({ path }) => path ? [path] : []);
  if (new Set(resolved).size < resolved.length) diagnostics.push({ code: "FILE_TARGET_COLLISION", severity: "error", message: "Multiple files in this manifest resolve to the same local destination." });
  const present = mappedFiles.filter((file) => file.present).length;
  const originItemId = digest(`${source.descriptor.originId}/${item.name}`);
  const destinations = [...new Set(mappedFiles.flatMap(({ path }) => path ? [path] : []))].sort();
  return {
    ...item, id: digest(`${source.descriptor.id}/${item.name}`), originItemId,
    ownerId: digest(JSON.stringify([originItemId, destinations.length ? destinations : context.projectRoot])),
    sourceId: source.descriptor.id, scope: context.projectRoot, qualifiedName: `${source.descriptor.namespace}/${item.name}`, inCatalog, manifest,
    presence: !mappedFiles.length ? "unknown" : present === mappedFiles.length && !diagnostics.length ? "present" : present ? "partial" : diagnostics.length ? "unknown" : "absent",
    originConfidence: present ? "candidate" : "unknown", mappedFiles, diagnostics,
  };
}

export async function buildInventory(options: InventoryOptions = {}): Promise<InventoryReport> {
  return (await createInventorySession(options)).report;
}

export async function createInventorySession(options: InventoryOptions = {}): Promise<{
  report: InventoryReport; contexts: Map<string, ProjectContext>; sources: RegistrySource[]; client: RegistryClient; selected: ProjectContext;
}> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 || (options.offline && options.refresh)) {
    throw new CliError("INVALID_OPTIONS", "Use concurrency 1-16, and choose either offline or refresh mode.");
  }
  const env = options.env ?? process.env;
  const selected = discoverProject({ cwd: options.cwd, env });
  const roots = scopes(selected, options.workspace ?? false).sort();
  const contexts = new Map(roots.map((root) => [root, root === selected.projectRoot ? selected : discoverProject({ cwd: root, env })]));
  const diagnostics: Diagnostic[] = [...contexts.values()].flatMap((context) => context.diagnostics);
  const sources = roots.flatMap((root) => {
    const loaded = loadRegistrySources(root, env);
    diagnostics.push(...loaded.diagnostics);
    return loaded.sources;
  });
  const files = new Map<string, LocalFile>();
  const names = new Map<string, Set<string>>();
  for (const context of contexts.values()) {
    try {
      const local = scanLocalFiles(context);
      for (const file of local) files.set(file.path, file);
      names.set(context.projectRoot, localNames(local, Object.values(context.components?.resolvedAliases ?? {}).map(({ path }) => path)));
    } catch (error) {
      diagnostics.push({ code: error instanceof CliError ? error.code : "LOCAL_SCAN_FAILED", severity: "error", message: error instanceof CliError ? error.message : "Cannot read local alias directories.", path: context.projectRoot });
      names.set(context.projectRoot, new Set());
    }
  }
  const requested = new Map<string, Set<string>>();
  for (const qualified of options.items ?? []) {
    const match = /^(@[\w-]+)\/(.+)$/.exec(qualified);
    if (!match) throw new CliError("INVALID_ARGUMENT", "Inventory item addresses must use @namespace/item syntax.");
    const source = sources.find(({ descriptor }) => descriptor.scope === selected.projectRoot && descriptor.namespace === match[1]);
    if (!source) {
      diagnostics.push({ code: "REGISTRY_NOT_CONFIGURED", severity: "error", message: `Requested namespace ${match[1]} is unavailable in the --cwd package.`, path: selected.projectRoot });
      continue;
    }
    const items = requested.get(source.descriptor.id) ?? new Set<string>();
    items.add(match[2]!); requested.set(source.descriptor.id, items);
  }
  const client = new RegistryClient(options);
  const catalogs = await mapLimit(sources, concurrency, (source) => client.catalog(source));
  const entries = catalogs.flatMap((catalog) => {
    const source = sources.find(({ descriptor }) => descriptor.id === catalog.source.id)!;
    const context = contexts.get(source.descriptor.scope)!;
    const entries = new Map(catalog.items.map((item) => [item.name, { item, inCatalog: true }]));
    for (const name of requested.get(source.descriptor.id) ?? []) {
      if (!entries.has(name)) entries.set(name, { item: { name, type: "registry:item", files: [], dependencies: [], devDependencies: [], registryDependencies: [] }, inCatalog: false });
    }
    return [...entries.values()].map(({ item, inCatalog }) => ({ source, context, item, inCatalog, stale: catalog.status === "stale" }));
  });
  const items = await mapLimit(entries, concurrency, async ({ source, context, item, inCatalog, stale }) => {
    let entry = makeItem(item, source, context, inCatalog, stale ? "stale" : "catalog");
    const inspect = requested.get(source.descriptor.id)?.has(item.name) || names.get(context.projectRoot)?.has(item.name) || entry.mappedFiles.some(({ present }) => present);
    if (inspect) {
      try {
        const manifest = await client.fetch(source, item.name, "item");
        const detail = manifest.document.items[0];
        if (!detail || detail.name !== item.name) throw new CliError("REGISTRY_ITEM_MISMATCH", "Requested manifest returned a different item name.");
        entry = makeItem(detail, source, context, inCatalog, manifest.cache === "stale-cache" ? "stale" : "fetched");
        if (manifest.diagnostic) entry.diagnostics.push(manifest.diagnostic);
      } catch (error) {
        entry.manifest = "error";
        entry.diagnostics.push({ code: error instanceof CliError ? error.code : "REGISTRY_FETCH_FAILED", severity: "error", message: error instanceof CliError ? error.message : "Cannot read registry item manifest." });
      }
    }
    for (const mapped of entry.mappedFiles) {
      if (!mapped.present || !mapped.path || !mapped.contentHash) continue;
      const file = files.get(mapped.path) ?? { id: `local:${digest(mapped.path)}`, path: mapped.path, contentHash: mapped.contentHash, ownerCandidates: [], origin: "unknown" as const };
      if (!file.ownerCandidates.includes(entry.ownerId)) file.ownerCandidates.push(entry.ownerId);
      files.set(mapped.path, file);
    }
    return entry;
  });
  for (const file of files.values()) {
    file.ownerCandidates.sort();
    file.origin = file.ownerCandidates.length > 1 ? "ambiguous" : file.ownerCandidates.length ? "candidate" : "unknown";
  }
  for (const item of items) {
    if (item.mappedFiles.some(({ path }) => path && files.get(path)?.origin === "ambiguous")) item.originConfidence = "ambiguous";
  }
  const localFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const complete = !diagnostics.some(({ severity }) => severity === "error") && catalogs.every(({ status }) => status === "ready") &&
    items.every((item) => item.manifest !== "error" && item.manifest !== "stale" && !item.diagnostics.some(({ severity }) => severity === "error"));
  const report: InventoryReport = {
    projectRoot: selected.projectRoot, scopes: roots,
    sources: catalogs.map(({ items, ...catalog }) => ({ ...catalog, itemCount: items.length,
      ...(catalog.fetchedAt ? { ageMs: Math.max(0, Date.now() - Date.parse(catalog.fetchedAt)) } : {}) })),
    items: items.sort((a, b) => a.scope.localeCompare(b.scope) || a.qualifiedName.localeCompare(b.qualifiedName)), files: localFiles,
    counts: {
      sources: catalogs.length, incompleteSources: catalogs.filter(({ status }) => status !== "ready").length,
      catalogAddresses: items.filter(({ inCatalog }) => inCatalog).length,
      catalogItems: new Set(items.filter(({ inCatalog }) => inCatalog).map(({ originItemId }) => originItemId)).size,
      presentItemCandidates: new Set(items.filter(({ presence }) => presence === "present").map(({ ownerId }) => ownerId)).size,
      partialItemCandidates: new Set(items.filter(({ presence }) => presence === "partial").map(({ ownerId }) => ownerId)).size,
      localFiles: localFiles.length, ambiguousFiles: localFiles.filter(({ origin }) => origin === "ambiguous").length,
      unknownFiles: localFiles.filter(({ origin }) => origin === "unknown").length,
    }, diagnostics, complete,
  };
  return { report, contexts, sources, client, selected };
}
