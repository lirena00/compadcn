import { isWithin } from "../project/files.js";
import { CliError } from "../core/errors.js";
import { digest } from "../core/hash.js";
import { packageInfo } from "../lib/packageInfo.js";
import { reportProgress } from "../core/progress.js";
import { beginPlanning, finishPlanning, projectIdentity, type PlanningOptions } from "./context.js";
import { itemTarget, resolveTarget, type PlanTarget } from "./targets.js";
import { ownershipFor } from "./ownership.js";
import { localPath, ignoredDirectories } from "./paths.js";
import { deletionDiff } from "./diff.js";
import { parseCleanupPlan, parseOwnershipSnapshot, withId, type CleanupPlan, type CleanupOperation, type OwnershipSnapshot } from "./schema.js";
import { readObject } from "../project/files.js";
import { readBoundedBytes } from "./io.js";

export interface CleanupPlanOptions extends PlanningOptions {
  mode?:"prune"|"remove"; targets?:string[]; includeUnverified?:boolean; includeModified?:boolean;
  ownership?:OwnershipSnapshot; verificationScripts?:string[];
}

export async function createCleanupPlan(options:CleanupPlanOptions={},savedExclusions?:string[]):Promise<CleanupPlan> {
  const mode=options.mode ?? "prune";
  if(!["prune","remove"].includes(mode)||(mode==="remove"&&!options.targets?.length)||(mode==="prune"&&(options.targets?.length||options.includeUnverified||options.includeModified)) ||
    (options.verificationScripts!==undefined&&(!options.verificationScripts.length||options.verificationScripts.some((name)=>!/^[a-zA-Z0-9_][\w:.-]*$/.test(name)))))throw new CliError("INVALID_OPTIONS","Named remove plans need explicit targets; unverified/modified opt-ins apply only to named targets. Verification scripts must be valid package script names.");
  const ownership=options.ownership?parseOwnershipSnapshot(options.ownership):undefined;
  const context=await beginPlanning(options,savedExclusions);
  reportProgress(options,{stage:"planning",state:"start",message:"Checking ownership, complete file sets, and retained consumers"});
  const {report,graph,project}=context.session;
  const targets=mode==="remove"?options.targets!.map((reference)=>resolveTarget(context,reference)):report.items.filter(({usage})=>usage==="unused-candidate").map((item)=>itemTarget(context,item));
  const unique=[...new Map(targets.map((target)=>[target.id,target])).values()].sort((a,b)=>a.id.localeCompare(b.id));
  const reasons=new Map(unique.map((target)=>[target.id,[] as string[]]));
  const ownershipStates=new Map(unique.map((target)=>[target.id,ownershipFor(context,target,ownership)]));
  const inputs=new Map(context.inputs.files.map((file)=>[file.path,file]));
  const nodes=new Map(graph.nodes.map((node)=>[node.id,node]));
  for(const target of unique){
    const why=reasons.get(target.id)!,state=ownershipStates.get(target.id)!;
    if(!context.complete)why.push("ANALYSIS_OR_INPUTS_INCOMPLETE");
    if(target.files.some(({usage})=>usage!=="unused-candidate")||(target.item&&target.item.usage!=="unused-candidate"))why.push("USAGE_RETAINED");
    why.push(...(target.item?.retention.filter((reason)=>reason!=="OWNERSHIP_UNVERIFIED"&&reason!=="REGISTRY_DEPENDENT_RETAINED") ?? []));
    if(!state.verified){
      if(state.reasons.includes("OWNERSHIP_MAPPING_CHANGED")||!options.includeUnverified)why.push(...state.reasons);
    }
    if(state.modified&&!options.includeModified)why.push("MODIFIED_SINCE_SNAPSHOT");
    for(const file of target.files){
      const path=localPath(context.inputs.root,file.path),input=inputs.get(path);
      if(file.scope!==project.projectRoot||!isWithin(project.projectRoot,file.path))why.push("SHARED_WORKSPACE_FILE_RETAINED");
      if(!/\.(?:[cm]?[jt]sx?)$/.test(path)||path.split("/").some((part)=>ignoredDirectories.has(part)))why.push("NON_CODE_OR_PROTECTED_FILE");
      if(!input||input.kind!=="file"||input.links!==1)why.push("FILE_INPUT_UNSUPPORTED");
      if(input&&input.bytes>2*1024*1024)why.push("FILE_PREVIEW_LIMIT");
      if(nodes.get(file.id)?.contentHash!==input?.sha256)why.push("FILE_INPUT_CHANGED");
    }
  }
  const eligible=new Set(unique.filter((target)=>!reasons.get(target.id)!.length).map(({id})=>id));
  const owners=new Map<string,Set<string>>();
  for(const item of report.items)for(const file of item.files){const rows=owners.get(file)??new Set<string>();rows.add(item.id);owners.set(file,rows);}
  const incoming=new Map<string,string[]>();
  for(const edge of graph.edges)if(edge.kind==="file-import"&&edge.status==="resolved"){const rows=incoming.get(edge.to)??[];rows.push(edge.from);incoming.set(edge.to,rows);}
  const retainDependents=()=>{
    let changed=true;
    while(changed){
      changed=false;const deleted=new Set(unique.filter(({id})=>eligible.has(id)).flatMap(({files})=>files.map(({id})=>id)));
      for(const target of unique)if(eligible.has(target.id)){
        const why=reasons.get(target.id)!;
        if(target.item?.declaredDependents.some(({id})=>!eligible.has(id)))why.push("REGISTRY_DEPENDENT_RETAINED");
        if(target.files.some(({id})=>[...(owners.get(id)??[])].some((owner)=>!eligible.has(owner))))why.push("SHARED_FILE_OWNER_RETAINED");
        if(target.files.some(({id})=>(incoming.get(id)??[]).some((from)=>!deleted.has(from))))why.push("SOURCE_CONSUMER_RETAINED");
        if(why.length){eligible.delete(target.id);changed=true;}
      }
    }
  };
  retainDependents();
  const previews=new Map<string,{file:CleanupOperation["before"];diff:string}>();
  let previewBytes=0;
  for(const target of unique)if(eligible.has(target.id)){
    const additions: [string,{file:CleanupOperation["before"];diff:string}][]=[];
    for(const file of target.files){
      const path=localPath(context.inputs.root,file.path);if(previews.has(path))continue;
      try{
        const bytes=await readBoundedBytes(file.path,2*1024*1024),content=bytes.toString("utf8"),input=inputs.get(path)!;
        if(bytes.length>2*1024*1024||bytes.includes(0)||!Buffer.from(content).equals(bytes)||digest(bytes)!==input.sha256)throw new Error("Unsafe preview");
        const diff=deletionDiff(path,content);
        additions.push([path,{file:{sha256:input.sha256,bytes:input.bytes,mode:input.mode},diff}]);
      }catch{reasons.get(target.id)!.push("FILE_PREVIEW_UNAVAILABLE");break;}
    }
    const size=additions.reduce((sum,[,value])=>sum+Buffer.byteLength(value.diff),0);
    if(previews.size+additions.length>2000||previewBytes+size>8*1024*1024)reasons.get(target.id)!.push("PLAN_PREVIEW_LIMIT");
    if(reasons.get(target.id)!.length){eligible.delete(target.id);continue;}
    previewBytes+=size;for(const [path,preview] of additions)previews.set(path,preview);
  }
  retainDependents();
  const manifest=readObject(project.packageJsonPath,"PACKAGE_JSON_INVALID");
  const scripts=typeof manifest.scripts==="object"&&manifest.scripts!==null&&!Array.isArray(manifest.scripts)?manifest.scripts as Record<string,unknown>:{};
  const verification=(options.verificationScripts ?? ["typecheck","lint","build"]).map((script)=>{
    const configured=typeof scripts[script]==="string";
    return {script,status:configured?"configured" as const:"not-configured" as const,required:options.verificationScripts!==undefined||configured,
      command:project.packageManager?.name ?? "npm" as const,args:["run",script],...(configured?{scriptHash:digest(scripts[script] as string)}:{})};
  });
  if(verification.some(({required,status})=>required&&status==="not-configured"))context.diagnostics.push({code:"PLAN_VERIFICATION_MISSING",severity:"error",message:"An explicitly required verification script is missing."});
  await finishPlanning(context);
  if(!context.complete)for(const target of unique)if(eligible.has(target.id)){eligible.delete(target.id);reasons.get(target.id)!.push("ANALYSIS_OR_INPUTS_INCOMPLETE");}
  const selected:CleanupPlan["selected"]=unique.filter(({id})=>eligible.has(id)).map((target)=>({id:target.id,label:target.label,kind:target.kind,
    paths:target.files.map(({path})=>localPath(context.inputs.root,path)).sort(),reasons:["ANALYZERS_AGREE_UNREACHABLE"],ownership:ownershipStates.get(target.id)!.verified?"snapshot":"explicit-unverified",modified:ownershipStates.get(target.id)!.modified}));
  const operations:CleanupOperation[]=[...new Set(selected.flatMap(({paths})=>paths))].sort().map((path)=>{
    const preview=previews.get(path)!;
    return withId({kind:"delete-file" as const,path,before:preview.file,after:{exists:false as const},owners:selected.filter(({paths})=>paths.includes(path)).map(({id})=>id).sort(),diff:preview.diff});
  });
  const excluded:CleanupPlan["excluded"]=unique.filter(({id})=>!eligible.has(id)).map((target)=>({id:target.id,label:target.label,paths:target.files.map(({path})=>localPath(context.inputs.root,path)).sort(),reasons:[...new Set(reasons.get(target.id)!)].sort()}));
  if(mode==="prune")for(const item of report.items)if(!unique.some(({id})=>id===item.id))excluded.push({id:item.id,label:item.label,paths:item.files.map((id)=>localPath(context.inputs.root,nodes.get(id)!.path!)).sort(),reasons:["USAGE_RETAINED",...item.retention.filter((reason)=>reason!=="OWNERSHIP_UNVERIFIED")]});
  const blocked=!context.complete||(mode==="remove"&&excluded.length>0)||(!operations.length&&unique.length>0);
  if(blocked&&operations.length){
    // A named multi-item request is one review unit, so it never becomes a
    // partial executable plan when another named target is blocked.
    for(const target of selected)excluded.push({id:target.id,label:target.label,paths:target.paths,reasons:["NAMED_PLAN_BLOCKED"]});selected.length=0;operations.length=0;
  }
  const body={planVersion:1 as const,toolVersion:packageInfo.version,project:projectIdentity(project,report.scopes),mode,status:blocked?"blocked" as const:operations.length?"ready" as const:"empty" as const,
    policy:{targets:mode==="remove"?unique.map(({id})=>id):[],includeUnverified:!!options.includeUnverified,includeModified:!!options.includeModified,entries:options.entries ?? [],devEntries:options.devEntries ?? [],
      maxItems:options.maxItems ?? 2000,maxFiles:options.maxFiles ?? 20000,...(options.verificationScripts?{verificationScripts:options.verificationScripts}:{})},
    analysis:{snapshotId:report.snapshotId,graphSnapshotId:report.graphSnapshotId,configurationFingerprint:context.configuration,knipVersion:report.analysis.version,typescriptVersion:"5.8.3" as const,coverage:report.coverage},
    inputs:context.inputs,...(ownership?{ownership}:{}),selected,excluded:excluded.sort((a,b)=>a.id.localeCompare(b.id)),operations,
    retained:{packages:report.packages.map(({name,scope,status,reasons})=>({name,scope:localPath(context.inputs.root,scope),status,reasons})),resources:graph.nodes.filter(({kind,retained})=>kind==="resource"||retained).map((node)=>({id:node.id,kind:node.resourceKind ?? "resource",scope:localPath(context.inputs.root,node.scope)}))},
    verification,diagnostics:context.diagnostics,complete:context.complete};
  reportProgress(options,{stage:"planning",state:"complete",message:`Planned ${operations.length} file deletions; retained ${excluded.length} targets`});
  return parseCleanupPlan(withId(body));
}
