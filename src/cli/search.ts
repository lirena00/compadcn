import { searchCatalog } from "../catalog/search.js";
import type { CatalogSearchReport } from "../catalog/model.js";
import { CliError } from "../core/errors.js";
import { runTask } from "./task.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import type { InventoryCliOptions } from "./inventory.js";
import { terminalText } from "./text.js";

export interface SearchCliOptions extends InventoryCliOptions { registry:string[]; type:string[]; presence:string; limit:string }

export function formatSearch(report:CatalogSearchReport):string {
  const lines=[`Project: ${report.projectRoot}`,`Catalog: ${report.totalEntries} item bindings; ${report.matchedEntries} matches (${report.entries.length} shown)`];
  for(const entry of report.entries)lines.push(`${terminalText(entry.address)} [${entry.presence}; ${entry.type}]${report.scopes.length>1 ? ` [${terminalText(entry.scope)}]` : ""}${entry.description ? ` - ${terminalText(entry.description)}` : ""}`);
  for(const source of report.sources)lines.push(`${terminalText(source.source.namespace)} [${terminalText(source.source.scope)}]: ${source.status}; ${source.itemCount} items${source.cache.length ? ` (${source.cache.join(", ")})` : ""}`);
  if(report.omittedEntries)lines.push(`${report.omittedEntries} matches omitted. Narrow the query or increase --limit (up to 1000).`);
  for(const diagnostic of report.diagnostics)lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${terminalText(diagnostic.message,300)}`);
  lines.push(report.complete ? "Catalog search complete. Local presence does not establish registry ownership." : "Catalog search incomplete. Healthy and cached entries remain visible; check source status.");
  return lines.join("\n");
}

export async function runSearch(query:string|undefined,options:SearchCliOptions,outputOptions:OutputOptions):Promise<void> {
  if(!options.cache&&options.cacheDir)throw new CliError("INVALID_OPTIONS","Choose either --cache-dir or --no-cache.");
  const report=await runTask("Search",outputOptions,(task)=>searchCatalog({cwd:options.cwd,workspace:options.workspace,items:options.item,
    offline:options.offline,refresh:options.refresh,cacheDir:options.cache?options.cacheDir:false,concurrency:Number(options.concurrency),timeoutMs:Number(options.timeout),
    query,registries:options.registry,types:options.type,presence:options.presence as "any",limit:Number(options.limit),signal:task.signal,onProgress:task.onProgress}));
  const mode=getOutputMode(outputOptions),text=formatSearch(report);
  if(!report.complete)throw new CliError("CATALOG_INCOMPLETE",mode==="json" ? "Catalog coverage is incomplete; inspect source status and retained entries." : text,{catalog:report});
  new CliOutput(mode).success(report,text);
}
