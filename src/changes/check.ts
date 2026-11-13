import { discoverProject } from "../project/discover.js";
import { CliError } from "../core/errors.js";
import { canonicalJSON } from "../core/hash.js";
import { createCleanupPlan, type CleanupPlanOptions } from "./build.js";
import { projectIdentity } from "./context.js";
import { parseCleanupPlan } from "./schema.js";
import { takeScopeSnapshot, snapshotChanges } from "./snapshot.js";
import { validateArtifactExclusions } from "./io.js";

export interface PlanCheckResult { planId:string; valid:boolean; ready:boolean; diagnostics:{code:string;message:string;path?:string}[] }

export async function checkCleanupPlan(input:unknown,options:CleanupPlanOptions={}):Promise<PlanCheckResult> {
  const plan=parseCleanupPlan(input),diagnostics:PlanCheckResult["diagnostics"]=[];
  const result=()=>({planId:plan.id,valid:!diagnostics.length,ready:plan.status==="ready"&&!diagnostics.length,diagnostics});
  const project=discoverProject({cwd:options.cwd,env:options.env});
  const identity=projectIdentity(project,[]);
  if(identity.root!==plan.project.root||identity.selected!==plan.project.selected){diagnostics.push({code:"PLAN_PROJECT_MISMATCH",message:"Select the same project/workspace package that created this plan."});return result();}
  if(plan.status==="blocked"){diagnostics.push({code:"PLAN_BLOCKED",message:"This artifact contains a blocked proposal, not an executable cleanup plan."});return result();}
  try{await validateArtifactExclusions(plan,project);}catch(error){diagnostics.push({code:error instanceof CliError?error.code:"PLAN_EXCLUSION_INVALID",message:"The plan's excluded artifact paths are not valid current plan outputs."});return result();}
  const snapshot=await takeScopeSnapshot(plan.inputs.root,{signal:options.signal,excludedArtifacts:plan.inputs.excludedArtifacts,maxInputFiles:plan.inputs.limits.files,maxInputBytes:plan.inputs.limits.bytes});
  for(const change of snapshotChanges(plan.inputs,snapshot))diagnostics.push({...change,message:"Analyzed input scope changed; create a new plan."});
  if(diagnostics.length)return result();
  const expected=await createCleanupPlan({...options,artifactPath:undefined,mode:plan.mode,targets:plan.policy.targets,includeUnverified:plan.policy.includeUnverified,includeModified:plan.policy.includeModified,
    ownership:plan.ownership,entries:plan.policy.entries,devEntries:plan.policy.devEntries,maxItems:plan.policy.maxItems,maxFiles:plan.policy.maxFiles,verificationScripts:plan.policy.verificationScripts,
    maxInputFiles:plan.inputs.limits.files,maxInputBytes:plan.inputs.limits.bytes},plan.inputs.excludedArtifacts);
  if(!expected.complete)diagnostics.push({code:"PLAN_REVALIDATION_INCOMPLETE",message:"Fresh analysis could not re-establish complete cleanup coverage."});
  else if(expected.id!==plan.id||canonicalJSON(expected.operations)!==canonicalJSON(plan.operations))diagnostics.push({code:"PLAN_ELIGIBILITY_CHANGED",message:"Fresh analysis, ownership, configuration, or proposed operations differ; create a new plan."});
  return result();
}
