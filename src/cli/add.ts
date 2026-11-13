import { readFileSync } from "node:fs";
import { digest } from "../core/hash.js";
import { CliError } from "../core/errors.js";
import { CommandCancelled } from "../core/cancellation.js";
import { discoverProject } from "../project/discover.js";
import { createInventorySession, makeItem } from "../inventory/build.js";
import { mapFile } from "../inventory/files.js";
import type { InventoryItem } from "../inventory/types.js";
import { catalogEntries, validateCatalogFilters, type CatalogFilters } from "../catalog/model.js";
import { installSelected } from "../install/runner.js";
import { pickCatalog } from "./catalog-picker.js";
import { runTask } from "./task.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import { terminalText } from "./text.js";

export interface AddCliOptions {
  cwd:string; overwrite?:boolean; yes?:boolean; registry:string[]; type:string[]; query?:string;
  refresh?:boolean; cache:boolean; cacheDir?:string; concurrency:string; timeout:string;
}

export const installableTypes=new Set(["registry:ui","registry:component","registry:block","registry:hook","registry:lib","registry:page","registry:file","registry:item"]);

function requestedAddresses(values:string[]):string[] {
  const result=values.map((value)=>value.startsWith("@")?value:`@shadcn/${value}`);
  if(result.some((value)=>!/^@[\w-]+\/[\w./-]+$/.test(value)||value.split("/").slice(1).some((part)=>!part||part==="."||part==="..")))throw new CliError("INVALID_ARGUMENT","Component requests must be official names or configured @namespace/item addresses.");
  return [...new Set(result)];
}

export async function runAdd(components:string[],options:AddCliOptions,outputOptions:OutputOptions):Promise<void> {
  const mode=getOutputMode(outputOptions);
  if(mode!=="interactive"&&(!options.yes||!components.length))throw new CliError("INTERACTIVE_REQUIRED","Use explicit component addresses with --yes for a noninteractive installation, or open add in an interactive terminal.");
  if(!options.cache&&options.cacheDir)throw new CliError("INVALID_OPTIONS","Choose either --cache-dir or --no-cache.");
  if(options.yes&&!components.length)throw new CliError("INVALID_OPTIONS","Use --yes with explicit component addresses. Omit it to select and review catalog items interactively.");
  if(components.length&&(options.registry.length||options.type.length||options.query))throw new CliError("INVALID_OPTIONS","Registry, type, and query filters apply to the interactive catalog picker. Use qualified addresses for explicit selections.");
  const filters:CatalogFilters={registries:options.registry,types:options.type,query:options.query};
  validateCatalogFilters(filters);
  const requested=requestedAddresses(components);
  const outcome=await runTask("Add",outputOptions,async(task)=>{
    const context=discoverProject({cwd:options.cwd});
    const fatal=context.diagnostics.find(({severity})=>severity==="error");
    if(fatal)throw new CliError(fatal.code,fatal.message,{context});
    if(!context.components||!context.packageManager)throw new CliError("PROJECT_NOT_READY","Resolve project configuration with doctor before adding components.");
    const inputs=[context.packageJsonPath,context.components.path,...context.compilerConfigs];
    const fingerprints=new Map(inputs.map((path)=>[path,digest(readFileSync(path))]));
    const session=await createInventorySession({cwd:context.projectRoot,items:requested,refresh:options.refresh,cacheDir:options.cache?options.cacheDir:false,
      concurrency:Number(options.concurrency),timeoutMs:Number(options.timeout),signal:task.signal,onProgress:task.onProgress});
    if(task.signal.aborted)throw new CommandCancelled();
    task.pause();
    const local=session.report.items.filter(({scope})=>scope===context.projectRoot);
    let selected:InventoryItem[];
    if(requested.length) {
      selected=requested.map((address)=>{
        const item=local.find(({qualifiedName})=>qualifiedName===address);
        if(!item||item.manifest==="error")throw new CliError("COMPONENT_NOT_FOUND",`Cannot resolve ${address} from this package's configured registry.`,{diagnostics:item?.diagnostics ?? session.report.diagnostics});
        return item;
      });
    } else {
      const {intro,note}=await import("@clack/prompts");
      intro("shadcn-plus / Add components");
      const sourceLines=session.report.sources.filter(({source})=>source.scope===context.projectRoot).map((source)=>`${terminalText(source.source.namespace)}: ${source.status}; ${source.itemCount} items${source.cache.length?` (${source.cache.join(", ")})`:""}`);
      note(sourceLines.join("\n"),"Registry catalogs");
      note(`Tab selects one row; Enter reviews every selected item, including hidden matches.\nType @namespace or a registry type to narrow search. Local files present are disabled unless --overwrite is set.${options.query?`\nBase query: ${terminalText(options.query)}`:""}`);
      const entries=catalogEntries(session.report).filter((entry)=>entry.scope===context.projectRoot&&installableTypes.has(entry.type));
      const ids=await pickCatalog(entries,{...filters,scope:context.projectRoot},task.signal,options.overwrite);
      const chosen=new Set(ids);
      selected=local.filter(({id})=>chosen.has(id));
    }
    if(!selected.length)throw new CommandCancelled("No components selected. Installation was not started.");
    // Load only selected manifests; request deduplication and the existing cache
    // remain in this session. Never refetch catalogs in response to a query.
    const details:InventoryItem[]=[];
    for(const item of selected) {
      const source=session.sources.find(({descriptor})=>descriptor.id===item.sourceId)!;
      const fetched=await session.client.fetch(source,item.name,"item");
      if(fetched.cache==="stale-cache"||fetched.diagnostic?.severity==="error")throw new CliError("INSTALL_METADATA_INCOMPLETE","Selected component metadata is stale or incomplete. Refresh its registry before installation.");
      const remote=fetched.document.items[0]!;
      if(!installableTypes.has(remote.type)||!remote.files.length)throw new CliError("INSTALL_TYPE_UNSUPPORTED","The component picker installs file-based registry items. Style/theme/base-only operations require their upstream workflow.");
      const detail=makeItem(remote,source,context,item.inCatalog,"fetched");
      if(detail.diagnostics.some(({severity})=>severity==="error")||detail.mappedFiles.some(({path})=>!path))throw new CliError("INSTALL_DESTINATION_UNSUPPORTED","The selected manifest has unresolved destinations. Inspect inventory diagnostics before installing.",{item:detail.qualifiedName,diagnostics:detail.diagnostics});
      details.push(detail);
    }
    const skipped=options.overwrite?[]:details.filter(({presence})=>presence==="present").map(({qualifiedName})=>qualifiedName);
    const pending=details.filter(({presence})=>options.overwrite||presence!=="present");
    if(!pending.length)return {projectRoot:context.projectRoot,requested:details.map(({qualifiedName})=>qualifiedName),installed:[] as string[],skipped,verifiedFiles:0,sharedEffects:0};
    if(mode==="interactive"&&!options.yes) {
      const {note,confirm,isCancel}=await import("@clack/prompts");
      note(pending.map((item)=>`${terminalText(item.qualifiedName)}: ${item.mappedFiles.length} files; ${item.presence}${item.resources?.length?`; ${item.resources.length} shared effects`:""}`).join("\n"),`Review ${pending.length} selected items${options.overwrite?" (overwrite enabled)":""}`);
      note(`Installer: shadcn@4.23.0 via ${context.packageManager.name}\nProject: ${terminalText(context.projectRoot,300)}\nUpstream may install dependencies and update shared configuration. Existing files are ${options.overwrite?"eligible for overwrite":"kept by upstream"}.`);
      const answer=await confirm({message:"Install these selected components?",initialValue:false,signal:task.signal});
      if(isCancel(answer)||!answer)throw new CommandCancelled();
    }
    if(task.signal.aborted)throw new CommandCancelled();
    for(const [path,hash] of fingerprints)if(digest(readFileSync(path))!==hash)throw new CliError("PROJECT_CHANGED","Project configuration changed during selection. Re-run add to review the current destinations.");
    const addresses=requestedAddresses(pending.map(({qualifiedName})=>qualifiedName));
    task.beginMutation();
    await installSelected({cwd:context.projectRoot,manager:context.packageManager.name,addresses,overwrite:options.overwrite,signal:task.signal,interactive:mode==="interactive"});
    task.onProgress({stage:"verification",state:"start",message:"Checking selected component destinations"});
    const files=pending.flatMap((item)=>item.files.map((file)=>mapFile(file,context)));
    const missing=files.filter(({present,path,diagnostic})=>!present||!path||diagnostic);
    if(missing.length)throw new CliError("INSTALL_VERIFICATION_FAILED","The upstream installer exited successfully but expected selected files are missing or unresolved. Inspect the project before retrying.",{missing:missing.map(({path,registryPath,diagnostic})=>({path,registryPath,diagnostic}))});
    task.onProgress({stage:"verification",state:"complete",message:`Verified ${files.length} selected file destinations`});
    return {projectRoot:context.projectRoot,requested:details.map(({qualifiedName})=>qualifiedName),installed:addresses,skipped,verifiedFiles:files.length,sharedEffects:pending.reduce((sum,item)=>sum+(item.resources?.length ?? 0),0)};
  });
  const text=[`Project: ${outcome.projectRoot}`,`Installed: ${outcome.installed.length}; skipped with local files present: ${outcome.skipped.length}; verified selected files: ${outcome.verifiedFiles}`,
    ...outcome.installed.map((address)=>`Added ${terminalText(address)}`),...outcome.skipped.map((address)=>`Skipped ${terminalText(address)} (use --overwrite to replace local files)`),
    ...(outcome.sharedEffects?[`${outcome.sharedEffects} declared shared effects were delegated to upstream and are not independently verified.`]:[])].join("\n");
  new CliOutput(mode).success(outcome,text);
}
