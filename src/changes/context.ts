import { resolve } from "node:path";
import { createAuditSession, type AuditOptions } from "../audit/build.js";
import { discoverProject } from "../project/discover.js";
import { loadCompilerConfigs } from "../project/aliases.js";
import type { Diagnostic, ProjectContext } from "../project/types.js";
import { canonicalJSON, digest } from "../core/hash.js";
import { reportProgress } from "../core/progress.js";
import { takeScopeSnapshot, snapshotChanges, type SnapshotOptions } from "./snapshot.js";
import { ignoredDirectories, ignoredInputFile, localPath } from "./paths.js";
import { validateAnalysisOptions } from "../analysis/options.js";
import { validateSnapshotOptions } from "./snapshot.js";
import { CliError } from "../core/errors.js";
import { assertArtifactDestination } from "./io.js";

export interface PlanningOptions extends Omit<AuditOptions,"workspace">, SnapshotOptions { artifactPath?: string }

export function configurationFingerprint(project: ProjectContext): string {
  const root = project.workspace?.root ?? project.projectRoot;
  const scopes = [...new Set([root, project.projectRoot, ...(project.workspace?.packages.map(({root})=>root) ?? [])])].sort();
  const diagnostics: Diagnostic[] = [];
  const configs = scopes.flatMap((scope) => loadCompilerConfigs(scope, root, diagnostics).map(({path,config})=>({path,hash:digest(canonicalJSON(config))})));
  const { cwd: _cwd, ...context } = project;
  return digest(canonicalJSON({ context, configs, diagnostics }));
}

export function projectIdentity(project: ProjectContext, scopes: string[]) {
  const root = project.workspace?.root ?? project.projectRoot;
  return { root, selected: localPath(root, project.projectRoot), scopes: scopes.map((scope)=>localPath(root,scope)).sort() };
}

export async function beginPlanning(options: PlanningOptions, savedExclusions?: string[]) {
  validateAnalysisOptions(options); validateSnapshotOptions(options);
  if (!Number.isInteger(options.maxItems ?? 2000) || (options.maxItems ?? 2000)<1 || (options.maxItems ?? 2000)>10000 ||
    !Number.isInteger(options.maxFiles ?? 20000) || (options.maxFiles ?? 20000)<1 || (options.maxFiles ?? 20000)>100000 ||
    !Number.isInteger(options.concurrency ?? 4) || (options.concurrency ?? 4)<1 || (options.concurrency ?? 4)>16 ||
    !Number.isFinite(options.timeoutMs ?? 10000) || (options.timeoutMs ?? 10000)<=0 || (options.timeoutMs ?? 10000)>60000 || (options.offline&&options.refresh)) throw new CliError("INVALID_OPTIONS","Planning limits, concurrency, or registry request settings are invalid.");
  const project = discoverProject({cwd:options.cwd,env:options.env});
  const root = project.workspace?.root ?? project.projectRoot;
  if(options.artifactPath&&!savedExclusions)assertArtifactDestination(project,options.artifactPath);
  const excludedArtifacts = savedExclusions ?? (options.artifactPath && !localOutside(root,options.artifactPath) ? [localPath(root,resolve(options.artifactPath))] : []);
  reportProgress(options,{stage:"snapshot",state:"start",message:"Fingerprinting source, configuration, and workspace inputs"});
  const configuration = configurationFingerprint(project);
  const inputs = await takeScopeSnapshot(root,{...options,excludedArtifacts});
  reportProgress(options,{stage:"snapshot",state:"complete",message:`Fingerprinted ${inputs.files.length} input files`});
  const session = await createAuditSession({...options,workspace:true});
  const diagnostics: Diagnostic[] = [...inputs.diagnostics,...session.report.diagnostics.map((entry)=>({...entry,...(entry.path ? {path:localOutside(root,entry.path)?"[outside analyzed scope]":localPath(root,entry.path)} : {})}))];
  const indexed = new Map(inputs.files.map((file)=>[file.path,file]));
  for (const node of session.graph.nodes) if(node.kind==="file"&&node.path) {
    const path = localOutside(root,node.path) ? undefined : localPath(root,node.path);
    if (!path || path.split("/").some((part)=>ignoredDirectories.has(part)) || ignoredInputFile(path.split("/").at(-1)!)) diagnostics.push({code:"PLAN_INPUT_EXCLUDED",severity:"error",message:"An analyzed reference depends on an excluded generated input.",...(path?{path}:{})});
    else if(node.contentHash && indexed.get(path)?.sha256!==node.contentHash)diagnostics.push({code:"PLAN_INPUT_CHANGED",severity:"error",message:"Analyzed bytes do not match the initial input snapshot.",path});
  }
  return {session,inputs,configuration,diagnostics,options,index:{inputs:indexed,files:new Map(session.report.files.map((file)=>[file.id,file])),nodes:new Map(session.graph.nodes.map((node)=>[node.id,node]))},complete:inputs.complete&&session.report.complete&&!diagnostics.some(({severity})=>severity==="error")};
}

function localOutside(root:string,path:string):boolean {
  try {localPath(root,resolve(path));return false;}catch{return true;}
}

export type PlanningContext = Awaited<ReturnType<typeof beginPlanning>>;

export async function finishPlanning(context: PlanningContext): Promise<boolean> {
  const {options,inputs}=context;
  const current=await takeScopeSnapshot(inputs.root,{signal:options.signal,excludedArtifacts:inputs.excludedArtifacts,maxInputFiles:inputs.limits.files,maxInputBytes:inputs.limits.bytes});
  const changes=snapshotChanges(inputs,current);
  for(const change of changes)context.diagnostics.push({...change,severity:"error",message:"Project inputs changed during planning; create a new plan."});
  try {
    const project=discoverProject({cwd:options.cwd,env:options.env});
    if(configurationFingerprint(project)!==context.configuration)throw new Error("Changed configuration");
  } catch {context.diagnostics.push({code:"PLAN_CONFIGURATION_CHANGED",severity:"error",message:"Resolved project or compiler configuration changed during planning."});}
  context.complete=context.complete&&current.complete&&!context.diagnostics.some(({severity})=>severity==="error");
  return context.complete;
}
