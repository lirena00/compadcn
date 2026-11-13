import { canonicalJSON } from "../core/hash.js";
import { packageInfo } from "../lib/packageInfo.js";
import { beginPlanning, finishPlanning, projectIdentity, type PlanningContext, type PlanningOptions } from "./context.js";
import { itemTarget, originProofs, resolveTarget, type PlanTarget } from "./targets.js";
import { localPath } from "./paths.js";
import { parseOwnershipSnapshot, withId, type OwnershipSnapshot } from "./schema.js";

export interface OwnershipOptions extends PlanningOptions { items?:string[] }

export async function createOwnershipSnapshot(options:OwnershipOptions={}):Promise<OwnershipSnapshot> {
  const context=await beginPlanning(options);
  const targets=options.items?.length?options.items.map((reference)=>resolveTarget(context,reference)):context.session.report.items.map((item)=>itemTarget(context,item));
  const items:OwnershipSnapshot["items"]=[],excluded:OwnershipSnapshot["excluded"]=[];
  const indexed=context.index.inputs;
  for(const target of [...new Map(targets.map((target)=>[target.id,target])).values()]) {
    const reasons:string[]=[];
    if(target.kind!=="item")reasons.push("OWNERSHIP_ITEM_REQUIRED");
    if(target.item?.retention.includes("PARTIAL_ITEM"))reasons.push("PARTIAL_ITEM");
    // Ambiguous candidates remain visible, rather than silently choosing one
    // registry as historical truth. Named unverified cleanup cannot waive it.
    if(target.item?.retention.includes("OWNERSHIP_AMBIGUOUS"))reasons.push("OWNERSHIP_AMBIGUOUS");
    const origins=originProofs(context,target);
    if(!origins.length||origins.length!==(target.item?.nodeIds.length ?? 0))reasons.push("OWNERSHIP_MANIFEST_INCOMPLETE");
    const files=target.files.map((file)=>({path:localPath(context.inputs.root,file.path),sha256:indexed.get(localPath(context.inputs.root,file.path))?.sha256}));
    if(files.some(({path,sha256})=>!sha256||indexed.get(path)?.kind!=="file"||indexed.get(path)?.links!==1))reasons.push("OWNERSHIP_FILE_UNSUPPORTED");
    if(reasons.length){excluded.push({id:target.id,label:target.label,paths:files.map(({path})=>path),reasons});continue;}
    items.push({id:target.id,addresses:target.item!.addresses,scope:localPath(context.inputs.root,target.item!.scopes[0]!),origins,files:files as {path:string;sha256:string}[]});
  }
  await finishPlanning(context);
  const body={ownershipVersion:1 as const,toolVersion:packageInfo.version,project:projectIdentity(context.session.project,context.session.report.scopes),baseline:"observed-local-files" as const,
    items:context.complete?items.sort((a,b)=>a.id.localeCompare(b.id)):[],excluded:excluded.sort((a,b)=>a.id.localeCompare(b.id)),diagnostics:context.diagnostics,complete:context.complete};
  return parseOwnershipSnapshot(withId(body));
}

export function ownershipFor(context:PlanningContext,target:PlanTarget,snapshot:OwnershipSnapshot|undefined):{verified:boolean;modified:boolean;reasons:string[]} {
  const record=snapshot?.items.find(({id})=>id===target.id);
  if(!record)return {verified:false,modified:false,reasons:["OWNERSHIP_UNVERIFIED"]};
  const paths=target.files.map(({path})=>localPath(context.inputs.root,path)).sort();
  if(!snapshot!.complete||snapshot!.project.root!==context.inputs.root||canonicalJSON(record.files.map(({path})=>path).sort())!==canonicalJSON(paths)||canonicalJSON(record.origins)!==canonicalJSON(originProofs(context,target)))return {verified:false,modified:false,reasons:["OWNERSHIP_MAPPING_CHANGED"]};
  const indexed=context.index.inputs;
  return {verified:true,modified:record.files.some(({path,sha256})=>indexed.get(path)?.sha256!==sha256),reasons:[]};
}
