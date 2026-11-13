import { CliError } from "../core/errors.js";
import { createCleanupPlan } from "../changes/build.js";
import { createOwnershipSnapshot } from "../changes/ownership.js";
import { checkCleanupPlan } from "../changes/check.js";
import { parseCleanupPlan, parseOwnershipSnapshot, type CleanupPlan, type OwnershipSnapshot } from "../changes/schema.js";
import { readArtifact, writeArtifact } from "../changes/io.js";
import { discoverProject } from "../project/discover.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import { runTask } from "./task.js";
import { terminalText } from "./text.js";
import type { AuditCliOptions } from "./audit.js";

export interface PlanCliOptions extends AuditCliOptions {
  out?:string; ownership?:string; item?:string[]; includeUnverified?:boolean; includeModified?:boolean;
  verifyScript?:string[]; maxInputFiles:string; maxInputBytes:string;
}

export function summarizePlan(plan:CleanupPlan) {
  return {planVersion:plan.planVersion,id:plan.id,mode:plan.mode,status:plan.status,project:plan.project,complete:plan.complete,
    counts:{selected:plan.selected.length,excluded:plan.excluded.length,files:plan.operations.length,inputFiles:plan.inputs.files.length},
    analysis:plan.analysis,inputFingerprint:plan.inputs.fingerprint,
    selected:plan.selected.map(({id,label,paths,ownership,modified})=>({id,label,paths,ownership,modified})),
    excluded:plan.excluded,verification:plan.verification,diagnostics:plan.diagnostics};
}

function terminalDiff(value:string):string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu,(character)=>character==="\n"||character==="\t"?character:`\\u${character.codePointAt(0)!.toString(16).padStart(4,"0")}`);
}

export function formatPlan(plan:CleanupPlan,summary=false):string {
  const lines=[`Cleanup plan: ${plan.id}`,`Status: ${plan.status}; mode: ${plan.mode}`,`Project: ${plan.project.selected} [${plan.project.root}]`,
    `Selected targets: ${plan.selected.length}; file deletions: ${plan.operations.length}; retained targets: ${plan.excluded.length}`,
    `Input fingerprint: ${plan.inputs.fingerprint} (${plan.inputs.files.length} files)`];
  for(const target of plan.selected)lines.push(`SELECT ${terminalText(target.label)} [${target.ownership}${target.modified?"; modified inclusion":""}]`);
  if(!summary)for(const operation of plan.operations)lines.push(`DELETE ${terminalText(operation.path,4096)} (${operation.before.bytes} bytes; ${operation.before.sha256})`,terminalDiff(operation.diff));
  for(const target of plan.excluded)lines.push(`KEEP ${terminalText(target.label)}: ${target.reasons.join(", ")}`);
  for(const pkg of plan.retained.packages)lines.push(`KEEP PACKAGE ${terminalText(pkg.name)} [${pkg.status}]`);
  lines.push(`Retained shared resources: ${plan.retained.resources.length}`);
  for(const step of plan.verification)lines.push(`Verification ${step.script}: ${step.status}${step.required?"; required":""}; not run during planning`);
  for(const diagnostic of plan.diagnostics)lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${terminalText(diagnostic.message,500)}${diagnostic.path?` [${terminalText(diagnostic.path,4096)}]`:""}`);
  lines.push("Planning only. No project source, imports, packages, or lockfiles were changed.");
  return lines.join("\n");
}

export async function runPlan(kind:"prune"|"remove"|"snapshot",references:string[],options:PlanCliOptions,outputOptions:OutputOptions):Promise<void> {
  if(!options.cache&&options.cacheDir)throw new CliError("INVALID_OPTIONS","Choose either --cache-dir or --no-cache.");
  const mode=getOutputMode(outputOptions);
  const artifact=await runTask("Planning",outputOptions,async(task)=>{
    const base={cwd:options.cwd,offline:options.offline,refresh:options.refresh,cacheDir:options.cache?options.cacheDir:false as const,
      concurrency:Number(options.concurrency),timeoutMs:Number(options.timeout),maxItems:Number(options.maxItems),maxFiles:Number(options.maxFiles),
      analysisTimeoutMs:Number(options.analysisTimeout),entries:options.entry,devEntries:options.devEntry,
      maxInputFiles:Number(options.maxInputFiles),maxInputBytes:Number(options.maxInputBytes),artifactPath:options.out,signal:task.signal,onProgress:task.onProgress};
    if(kind==="snapshot")return createOwnershipSnapshot({...base,items:options.item});
    const ownership=options.ownership?parseOwnershipSnapshot(await readArtifact(options.ownership)):undefined;
    return createCleanupPlan({...base,mode:kind,targets:references,includeUnverified:options.includeUnverified,includeModified:options.includeModified,ownership,verificationScripts:options.verifyScript});
  });
  const output=options.out?await writeArtifact(artifact,options.out,discoverProject({cwd:options.cwd})):undefined;
  if("planVersion" in artifact){
    const data={plan:options.summary?summarizePlan(artifact):artifact,...(output?{output}:{})};
    const text=formatPlan(artifact,options.summary)+(output?`\nArtifact: ${output}`:"");
    if(!artifact.complete||artifact.status==="blocked")throw new CliError(!artifact.complete?"PLAN_INCOMPLETE":"PLAN_BLOCKED",mode==="json"?"Cleanup proposal retains blocked targets; inspect its eligibility reasons and diagnostics.":text,data);
    new CliOutput(mode).success(data,text);
  }else{
    const snapshot:OwnershipSnapshot=artifact;
    const data={ownership:options.summary?{ownershipVersion:snapshot.ownershipVersion,id:snapshot.id,project:snapshot.project,baseline:snapshot.baseline,counts:{mapped:snapshot.items.length,excluded:snapshot.excluded.length},complete:snapshot.complete,excluded:snapshot.excluded,diagnostics:snapshot.diagnostics}:snapshot,...(output?{output}:{})};
    const lines=[`Ownership snapshot: ${snapshot.id}`,`Observed mappings: ${snapshot.items.length}; excluded: ${snapshot.excluded.length}`,
      ...(!options.summary?snapshot.items.map((item)=>`${terminalText(item.addresses.join(", "))}: ${item.files.length} observed files`):[]),
      ...snapshot.excluded.map((item)=>`EXCLUDED ${terminalText(item.label)}: ${item.reasons.join(", ")}`),
      ...snapshot.diagnostics.map((diagnostic)=>`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${terminalText(diagnostic.message,500)}`),
      "Review these mappings before supplying --ownership to a cleanup plan. This is an observed local baseline, not upstream installation history.",...(output?[`Artifact: ${output}`]:[])];
    if(!snapshot.complete)throw new CliError("OWNERSHIP_INCOMPLETE",mode==="json"?"Ownership snapshot coverage is incomplete.":lines.join("\n"),data);
    new CliOutput(mode).success(data,lines.join("\n"));
  }
}

export async function runPlanCheck(path:string,options:{cwd:string;offline?:boolean;refresh?:boolean;cache:boolean;cacheDir?:string;concurrency:string;timeout:string;analysisTimeout:string},outputOptions:OutputOptions):Promise<void> {
  if(!options.cache&&options.cacheDir)throw new CliError("INVALID_OPTIONS","Choose either --cache-dir or --no-cache.");
  const plan=parseCleanupPlan(await readArtifact(path));
  const result=await runTask("Plan check",outputOptions,(task)=>checkCleanupPlan(plan,{cwd:options.cwd,offline:options.offline,refresh:options.refresh,cacheDir:options.cache?options.cacheDir:false,
    concurrency:Number(options.concurrency),timeoutMs:Number(options.timeout),analysisTimeoutMs:Number(options.analysisTimeout),signal:task.signal,onProgress:task.onProgress}));
  const text=[`Plan: ${result.planId}`,`Valid: ${result.valid}; ready: ${result.ready}`,...result.diagnostics.map(({code,message,path})=>`${code}: ${message}${path?` [${terminalText(path,4096)}]`:""}`),"Read-only validation; no verification scripts or cleanup operations were executed."].join("\n");
  const mode=getOutputMode(outputOptions);
  if(!result.valid)throw new CliError(result.diagnostics[0]?.code==="PLAN_PROJECT_MISMATCH"?"PLAN_PROJECT_MISMATCH":result.diagnostics[0]?.code==="PLAN_BLOCKED"?"PLAN_BLOCKED":"PLAN_STALE",mode==="json"?"Plan could not be revalidated against current project inputs and analysis.":text,{check:result});
  new CliOutput(mode).success(result,text);
}
