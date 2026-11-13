import { basename } from "node:path";
import { CliError } from "../core/errors.js";
import { createCollection } from "../collections/model.js";
import { listCollections, readCollection, writeCollection } from "../collections/files.js";
import type { MigrationReport } from "../collections/migrate.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import { terminalText } from "./text.js";
import { runTask } from "./task.js";
import type { AddCliOptions } from "./add.js";

export async function runCollectionCreate(path: string, items: string[], options: { name?: string; description?: string; from: string[] }, outputOptions: OutputOptions): Promise<void> {
  if (options.from.length > 20) throw new CliError("COLLECTION_LIMIT", "Compose at most 20 base collection files at once.");
  const bases = [];
  for (const file of options.from) bases.push(await readCollection(file));
  const collection = createCollection({ name: options.name ?? basename(path, ".json").replace(/\.collection$/, ""), description: options.description, items, bases });
  const output = await writeCollection(collection, path);
  new CliOutput(getOutputMode(outputOptions)).success({ collection, output }, `Created ${terminalText(collection.name)}: ${collection.items.length} items\n${terminalText(output, 4096)}`);
}

export async function runCollectionShow(path: string, outputOptions: OutputOptions): Promise<void> {
  const collection = await readCollection(path);
  new CliOutput(getOutputMode(outputOptions)).success({ collection }, [terminalText(collection.name), terminalText(collection.description, 4096), ...collection.items.map(item => `  ${item}`)].join("\n"));
}

export async function runCollectionList(directory: string, outputOptions: OutputOptions): Promise<void> {
  const collections = await listCollections(directory), mode = getOutputMode(outputOptions);
  const text = [`Collections: ${terminalText(collections.directory, 4096)}`, ...collections.entries.map(entry => entry.error ? `${terminalText(entry.path, 4096)}: ${entry.error}` : `${terminalText(entry.name!)}: ${entry.items} items [${terminalText(entry.path, 4096)}]`), `${collections.entries.length} files`].join("\n");
  if (!collections.complete) throw new CliError("COLLECTION_LIST_INCOMPLETE", mode === "json" ? "Some JSON files are not valid collections." : text, { collections });
  new CliOutput(mode).success({ collections }, text);
}

export async function runCollectionInstall(path: string, options: Omit<AddCliOptions, "registry" | "type" | "query">, outputOptions: OutputOptions): Promise<void> {
  if (!options.yes && getOutputMode(outputOptions) !== "interactive") throw new CliError("INTERACTIVE_REQUIRED", "Use collection install <path> --yes for noninteractive installation.");
  const collection = await readCollection(path);
  const { runAdd } = await import("./add.js");
  await runAdd(collection.items, { ...options, registry: [], type: [] }, outputOptions);
}

export interface MigrationCliOptions {
  from?: string; out?: string; preset: string[]; map: string[]; cwd: string; offline?: boolean; refresh?: boolean;
  cache: boolean; cacheDir?: string; concurrency: string; timeout: string;
}

function formatMigration(report: MigrationReport): string {
  return [`Legacy migration: ${report.status}`, `Source: ${terminalText(report.source.path, 4096)}`, `Source hash: ${report.source.sha256}`,
    ...report.entries.flatMap(entry => [`${terminalText(entry.id)}: ${entry.collection ? `${terminalText(entry.collection.name)}; ${entry.collection.items.length} items -> ${entry.filename}` : "needs review"}`,
      ...entry.issues.map(issue => `  ${issue.code}${issue.component ? ` at component ${issue.component}` : ""}${issue.candidates?.length ? `: ${issue.candidates.join(", ")}` : ""}`)]),
    ...(report.backup ? [`Original backup: ${terminalText(report.backup, 4096)}`, `Wrote ${report.entries.length} collection files. Legacy storage was preserved.`] : ["No migration files written. Review mappings, then use --out <new-directory>."]),
    ...(!report.complete ? ["Resolve entries with --map legacy-value=@namespace/item, or select specific --preset IDs."] : []),
  ].join("\n");
}

export async function runCollectionMigration(options: MigrationCliOptions, outputOptions: OutputOptions): Promise<void> {
  if (!options.cache && options.cacheDir) throw new CliError("INVALID_OPTIONS", "Choose either --cache-dir or --no-cache.");
  const mappings = new Map<string, string>();
  for (const mapping of options.map) {
    const split = mapping.indexOf("="), key = mapping.slice(0, split), value = mapping.slice(split + 1);
    if (split <= 0 || (mappings.has(key) && mappings.get(key) !== value)) throw new CliError("MIGRATION_MAPPING_INVALID", "Use one unambiguous --map legacy-value=@namespace/item per legacy value.");
    mappings.set(key, value);
  }
  const report = await runTask("Migration", outputOptions, async task => {
    const { migrateLegacyPresets } = await import("../collections/migrate.js");
    return migrateLegacyPresets({ source: options.from, output: options.out, presets: options.preset, mappings: Object.fromEntries(mappings), cwd: options.cwd,
      offline: options.offline, refresh: options.refresh, cacheDir: options.cache ? options.cacheDir : false, concurrency: Number(options.concurrency), timeoutMs: Number(options.timeout), signal: task.signal, onProgress: task.onProgress });
  }, { handlesCancellation: true });
  const mode = getOutputMode(outputOptions), text = formatMigration(report);
  if (!report.complete) throw new CliError("MIGRATION_BLOCKED", mode === "json" ? "Legacy references need review; no collection files or backup were written." : text, { migration: report });
  new CliOutput(mode).success({ migration: report }, text);
}
