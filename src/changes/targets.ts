import { CliError } from "../core/errors.js";
import { explainAudit } from "../audit/why.js";
import type { FileFinding, ItemFinding } from "../audit/types.js";
import type { PlanningContext } from "./context.js";
import { localPath } from "./paths.js";

export interface PlanTarget {
  id:string; label:string; kind:"item"|"file"; files:FileFinding[]; item?:ItemFinding;
}

export function itemTarget(context:PlanningContext,item:ItemFinding):PlanTarget {
  const files=new Map(context.session.report.files.map((file)=>[file.id,file]));
  return {id:item.id,label:item.label,kind:"item",item,files:item.files.map((id)=>files.get(id)!)};
}

export function resolveTarget(context:PlanningContext,reference:string):PlanTarget {
  const why=explainAudit(context.session.report,reference);
  if(why.target.kind==="package")throw new CliError("PLAN_PACKAGE_RETAINED","Package removal is outside file-cleanup plans.");
  if(why.target.kind==="item")return itemTarget(context,why.target.finding);
  if(!why.target.finding.unmapped)throw new CliError("PLAN_TARGET_OWNED","Select the owning registry item to plan its complete file set.");
  return {id:why.target.finding.id,label:localPath(context.inputs.root,why.target.finding.path),kind:"file",files:[why.target.finding]};
}

export function originProofs(context:PlanningContext,target:PlanTarget,nodeIds=target.item?.nodeIds ?? []) {
  const nodes=new Map(context.session.graph.nodes.map((node)=>[node.id,node]));
  return nodeIds.map((id)=>nodes.get(id)!).filter((node)=>node?.manifestHash).map((node)=>({nodeId:node.id,addresses:node.addresses ?? [node.label],sourceIds:node.sourceIds ?? [],manifestHash:node.manifestHash!})).sort((a,b)=>a.nodeId.localeCompare(b.nodeId));
}
