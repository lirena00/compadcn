import { CommandCancelled } from "../core/cancellation.js";
import { CliError } from "../core/errors.js";
import { createCatalogIndex, type CatalogEntry, type CatalogFilters } from "../catalog/model.js";
import { terminalText } from "./text.js";
import type { Readable, Writable } from "node:stream";

export async function pickCatalog(entries: CatalogEntry[], filters: CatalogFilters, signal: AbortSignal, overwrite = false, io:{input?:Readable;output?:Writable}={}): Promise<string[]> {
  const filtered=createCatalogIndex(entries,filters);
  const index=createCatalogIndex(filtered.search());
  if(!index.entries.length)throw new CliError("CATALOG_NO_MATCHES","No catalog items match these registry, type, and presence filters.");
  const {autocompleteMultiselect,isCancel}=await import("@clack/prompts");
  const width=Math.max(24,process.stdout.columns ?? 100);
  const options=index.entries.map((entry)=>({value:entry.id,
    label:terminalText(`${entry.address} [${entry.presence==="present" ? "local files present" : entry.presence==="partial" ? "partial local files" : entry.presence==="absent" ? "available" : "presence unknown"}]`,Math.max(24,width-8)),
    hint:terminalText(`${entry.type}; ${entry.description ?? entry.title ?? ""}${entry.sourceStatus!=="ready" ? `; source ${entry.sourceStatus}` : ""}`,Math.max(24,width-8)),
    disabled:entry.metadata==="error" || entry.sourceStatus==="error" || (!overwrite&&entry.presence==="present")}));
  // Clack 1.9 initializes autocomplete focus on the first option, even when
  // disabled. Start on an enabled option and validate the returned IDs too.
  options.sort((a,b)=>Number(a.disabled)-Number(b.disabled));
  if(options.every(({disabled})=>disabled))throw new CliError("CATALOG_NO_AVAILABLE","Every matching item has local files present or unavailable metadata. Use --overwrite to review replacements, or resolve source diagnostics.");
  let selectionState:{readonly selectedValues:string[]}|undefined;
  const selection=await autocompleteMultiselect<string>({
    get message(){return `Add components: ${selectionState?.selectedValues.length ?? 0} selected (${index.entries.length} matching catalog items)`;},
    options(){selectionState=this;return options;},
    filter:(query,option)=>index.matches(query,option.value),
    initialValues:[], required:false,
    placeholder:"Search names, @registry, descriptions, or types",
    maxItems:Math.max(1,Math.min(10,(process.stdout.rows ?? 24)-10)), signal, ...io,
  });
  if(isCancel(selection))throw new CommandCancelled();
  const allowed=new Set(options.filter(({disabled})=>!disabled).map(({value})=>value));
  if(selection.some((id)=>!allowed.has(id)))throw new CliError("PICKER_SELECTION_INVALID","The picker returned an unavailable item; no installation was started.");
  return selection;
}
