import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError } from "../core/errors.js";
import { CommandCancelled } from "../core/cancellation.js";
import { digest } from "../core/hash.js";
import { isObject } from "../project/files.js";
import { installableTypes, isQualifiedAddress } from "../catalog/requests.js";
import type { InventoryOptions } from "../inventory/build.js";
import { createCollection, type Collection } from "./model.js";
import { assertNewPath, readCollectionBytes, writeNewFile } from "./files.js";

export interface MigrationOptions extends Pick<InventoryOptions, "cwd" | "env" | "offline" | "refresh" | "cacheDir" | "concurrency" | "timeoutMs" | "signal" | "onProgress"> {
  source?: string; output?: string; presets?: string[]; mappings?: Record<string, string>;
}
export interface MigrationIssue { code: string; component?: number; candidates?: string[] }
export interface MigrationReport {
  migrationVersion: 1; status: "preview" | "blocked" | "written"; source: { path: string; sha256: string };
  entries: { id: string; filename: string; collection?: Collection; issues: MigrationIssue[] }[];
  catalogComplete?: boolean; backup?: string; writtenFiles: string[]; complete: boolean;
}

export async function migrateLegacyPresets(options: MigrationOptions = {}): Promise<MigrationReport> {
  if ((options.offline && options.refresh) || !Number.isInteger(options.concurrency ?? 4) || (options.concurrency ?? 4) < 1 || (options.concurrency ?? 4) > 16 ||
    !Number.isFinite(options.timeoutMs ?? 10000) || (options.timeoutMs ?? 10000) <= 0 || (options.timeoutMs ?? 10000) > 60000) throw new CliError("INVALID_OPTIONS", "Choose valid registry request limits and either offline or refresh mode.");
  const mappings = new Map(Object.entries(options.mappings ?? {}));
  if ([...mappings].some(([key, value]) => !key || key.length > 4096 || value.length > 4096 || !isQualifiedAddress(value))) throw new CliError("MIGRATION_MAPPING_INVALID", "Mappings must match a legacy value to a qualified @namespace/item address.");
  const source = resolve(options.source ?? join(homedir(), ".compadcn", "custom-presets.json"));
  const output = options.output ? await assertNewPath(options.output) : undefined;
  const bytes = await readCollectionBytes(source, 8 * 1024 * 1024), sha256 = digest(bytes);
  let data: unknown;
  try { data = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); } catch { throw new CliError("MIGRATION_SOURCE_INVALID", "Legacy storage is not valid JSON; the original was preserved."); }
  if (!isObject(data) || !isObject(data.presets)) throw new CliError("MIGRATION_SOURCE_INVALID", "Legacy storage must contain a presets object.");
  const presets = data.presets, all = Object.entries(presets);
  if (all.length > 1000 || all.some(([id]) => !id || id.length > 256)) throw new CliError("MIGRATION_SOURCE_INVALID", "Legacy preset IDs must be 1–256 characters; migrate at most 1000 presets at a time.");
  const selected = new Set(options.presets?.length ? options.presets : all.map(([id]) => id));
  if ([...selected].some(id => !Object.hasOwn(presets, id))) throw new CliError("LEGACY_PRESET_NOT_FOUND", "A requested legacy preset ID is not present in this file.");
  const rows = all.filter(([id]) => selected.has(id));
  const needsCatalog = rows.some(([, preset]) => isObject(preset) && Array.isArray(preset.components) && preset.components.some(component =>
    isObject(component) && typeof component.value === "string" && /^[\w-]+$/.test(component.value) && !mappings.has(component.value)));
  const candidates = new Map<string, Map<string, string[]>>();
  let catalogComplete: boolean | undefined;
  if (needsCatalog) {
    const { buildInventory } = await import("../inventory/build.js");
    const inventory = await buildInventory({ ...options, items: [], workspace: false });
    catalogComplete = inventory.complete;
    for (const item of inventory.items) if (item.scope === inventory.projectRoot && item.inCatalog && installableTypes.has(item.type) && isQualifiedAddress(item.qualifiedName)) {
      const origins = candidates.get(item.name) ?? new Map<string, string[]>();
      const addresses = origins.get(item.originItemId) ?? []; addresses.push(item.qualifiedName);
      origins.set(item.originItemId, addresses); candidates.set(item.name, origins);
    }
  }
  if (options.signal?.aborted) throw new CommandCancelled();
  const entries: MigrationReport["entries"] = rows.map(([id, preset]) => {
    const slug = id.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "collection";
    const filename = `${slug}-${digest(id).slice(0, 12)}.json`, issues: MigrationIssue[] = [], items: string[] = [];
    if (!isObject(preset) || typeof preset.label !== "string" || typeof preset.description !== "string" || !Array.isArray(preset.components) || preset.components.length > 1000) return { id, filename, issues: [{ code: "LEGACY_PRESET_INVALID" }] };
    for (const [index, component] of preset.components.entries()) {
      const value = isObject(component) ? component.value : undefined, mapped = typeof value === "string" ? mappings.get(value) : undefined;
      if (mapped) { items.push(mapped); continue; }
      if (typeof value !== "string" || value.length > 4096) { issues.push({ code: "LEGACY_COMPONENT_INVALID", component: index + 1 }); continue; }
      if (isQualifiedAddress(value)) { items.push(value); continue; }
      if (!/^[\w-]+$/.test(value)) { issues.push({ code: "LEGACY_COMPONENT_INVALID", component: index + 1 }); continue; }
      const origins = candidates.get(value), addresses = [...(origins?.values() ?? [])].flat().sort();
      if (!catalogComplete) { issues.push({ code: "MIGRATION_CATALOG_INCOMPLETE", component: index + 1, candidates: addresses }); continue; }
      if (!origins?.size) { issues.push({ code: "LEGACY_COMPONENT_UNKNOWN", component: index + 1 }); continue; }
      if (origins.size > 1) { issues.push({ code: "LEGACY_COMPONENT_AMBIGUOUS", component: index + 1, candidates: addresses }); continue; }
      items.push(addresses.find(address => address.startsWith("@shadcn/")) ?? addresses[0]!);
    }
    let collection: Collection | undefined;
    try { collection = createCollection({ name: preset.label, description: preset.description, items }); }
    catch { if (!issues.length) issues.push({ code: "LEGACY_PRESET_INVALID" }); }
    return { id, filename, ...(collection && !issues.length ? { collection } : {}), issues };
  });
  const complete = entries.every(entry => !entry.issues.length && !!entry.collection);
  const report: MigrationReport = { migrationVersion: 1, status: complete ? "preview" : "blocked", source: { path: source, sha256 }, entries,
    ...(catalogComplete !== undefined ? { catalogComplete } : {}), writtenFiles: [], complete };
  if (!complete || !output) return report;
  let unchanged = false;
  try { unchanged = digest(await readCollectionBytes(source, 8 * 1024 * 1024)) === sha256; } catch { /* Refuse writes if the source disappeared or changed type. */ }
  if (!unchanged) throw new CliError("MIGRATION_SOURCE_CHANGED", "Legacy storage changed during preview; rerun migration. No collection output was written.");
  if (options.signal?.aborted) throw new CommandCancelled();
  await mkdir(dirname(output), { recursive: true }); await assertNewPath(output);
  await mkdir(output, { mode: 0o700 });
  try {
    const backup = join(output, "legacy-custom-presets.json.bak");
    await writeNewFile(backup, bytes); report.backup = backup; report.writtenFiles.push(backup);
    for (const entry of entries) {
      const path = join(output, entry.filename);
      await writeNewFile(path, JSON.stringify(entry.collection, null, 2) + "\n"); report.writtenFiles.push(path);
    }
  } catch { throw new CliError("MIGRATION_WRITE_FAILED", "The original legacy file was preserved. Inspect partial outputs before choosing a new directory and retrying.", { output, writtenFiles: report.writtenFiles }); }
  report.status = "written"; return report;
}
