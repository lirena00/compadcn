import { CliError } from "../core/errors.js";
import { buildInventory, type InventoryOptions } from "../inventory/build.js";
import type { InventoryReport } from "../inventory/types.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";

export interface InventoryCliOptions {
  cwd: string;
  workspace?: boolean;
  item: string[];
  offline?: boolean;
  refresh?: boolean;
  cache: boolean;
  cacheDir?: string;
  concurrency: string;
  timeout: string;
}

export function formatInventory(report: InventoryReport): string {
  const counts = report.counts;
  const lines = [
    `Project: ${report.projectRoot}`,
    `Scopes: ${report.scopes.length}`,
    `Registries: ${counts.sources} (${counts.incompleteSources} incomplete)`,
    `Catalog: ${counts.catalogItems} unique items, ${counts.catalogAddresses} qualified addresses`,
    `Local files: ${counts.localFiles} (${counts.unknownFiles} unknown origin, ${counts.ambiguousFiles} ambiguous)`,
    `Item candidates: ${counts.presentItemCandidates} present, ${counts.partialItemCandidates} partial`,
  ];
  for (const source of report.sources) {
    lines.push(`${source.source.namespace} [${source.source.scope}]: ${source.status}, ${source.itemCount} catalog items${source.cache.length ? ` (${source.cache.join(", ")})` : ""}`);
    for (const diagnostic of source.diagnostics) lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
  for (const item of report.items) {
    if (["present", "partial"].includes(item.presence) || item.manifest === "error") {
      lines.push(`${item.qualifiedName} [${item.scope}]: ${item.presence}, ${item.originConfidence} origin (${item.mappedFiles.filter(({ present }) => present).length}/${item.mappedFiles.length} files)`);
    }
    for (const diagnostic of item.diagnostics) lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
  for (const diagnostic of report.diagnostics) lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? ` [${diagnostic.path}]` : ""}`);
  lines.push("Ownership candidates require review; inventory does not establish installation history or cleanup eligibility.");
  lines.push(report.complete ? "Inventory complete." : "Inventory incomplete. Healthy results are retained; resolve diagnostics before relying on remote coverage.");
  return lines.join("\n");
}

export async function runInventory(options: InventoryCliOptions, outputOptions: OutputOptions): Promise<void> {
  if (!options.cache && options.cacheDir) throw new CliError("INVALID_OPTIONS", "Choose either --cache-dir or --no-cache.");
  const settings: InventoryOptions = {
    cwd: options.cwd, workspace: options.workspace, items: options.item, offline: options.offline, refresh: options.refresh,
    cacheDir: options.cache ? options.cacheDir : false, concurrency: Number(options.concurrency), timeoutMs: Number(options.timeout),
  };
  const report = await buildInventory(settings);
  const mode = getOutputMode(outputOptions);
  const text = formatInventory(report);
  if (!report.complete) throw new CliError("INVENTORY_INCOMPLETE", mode === "json" ? "Inventory coverage is incomplete. See report diagnostics and per-source status." : text, { report });
  new CliOutput(mode).success(report, text);
}
