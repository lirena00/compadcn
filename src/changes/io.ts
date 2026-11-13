import { existsSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { CliError } from "../core/errors.js";
import { canonicalPath, isWithin } from "../project/files.js";
import type { ProjectContext } from "../project/types.js";
import { localPath, resolveLocal } from "./paths.js";
import { parseCleanupPlan, parseOwnershipSnapshot, type CleanupPlan, type OwnershipSnapshot } from "./schema.js";

const protectedName = /^(?:package|components|(?:tsconfig|jsconfig)(?:\.[^.]+)*|knip|biome|\.eslintrc)\.json$|\.config\.json$/i;

export function assertArtifactDestination(project: ProjectContext, output: string, allowExisting = false): string {
  const path = resolve(output), root = project.workspace?.root ?? project.projectRoot;
  if (!path.endsWith(".json") || protectedName.test(basename(path)) || /[\p{Cc}\p{Cf}]/u.test(path)) throw new CliError("PLAN_OUTPUT_INVALID", "Choose a JSON artifact filename that is not a project configuration file.");
  if (canonicalPath(path) !== path) throw new CliError("PLAN_OUTPUT_LINK", "Artifact destinations must not traverse symbolic links.");
  if (isWithin(root,path)) {
    const relative = localPath(root,path);
    if (!relative.split("/").includes(".shadcn-plus") && Object.entries(project.components?.resolvedAliases ?? {}).some(([name,alias])=>name!=="utils"&&isWithin(alias.path,path))) throw new CliError("PLAN_OUTPUT_MANAGED", "Store artifacts outside managed component directories, or under .shadcn-plus/plans.");
  }
  if (!allowExisting && existsSync(path)) throw new CliError("PLAN_OUTPUT_EXISTS", "Artifact output already exists. Choose a new filename; plans are never overwritten.");
  return path;
}

export async function readBoundedBytes(path: string,maxBytes=64*1024*1024): Promise<Buffer> {
  const absolute=resolve(path),stat=await lstat(absolute).catch(()=>{throw new CliError("PLAN_ARTIFACT_UNREADABLE","Cannot read the requested artifact.");});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw new CliError("PLAN_ARTIFACT_INVALID","Input is not an ordinary file within its size limit.");
  const handle=await open(absolute,"r");
  try {
    const chunks:Buffer[]=[];let length=0;
    while(true){const buffer=Buffer.alloc(64*1024);const {bytesRead}=await handle.read(buffer);if(!bytesRead)break;length+=bytesRead;if(length>maxBytes)throw new CliError("PLAN_ARTIFACT_INVALID","Input exceeds its size limit.");chunks.push(buffer.subarray(0,bytesRead));}
    return Buffer.concat(chunks);
  } finally {await handle.close();}
}

export async function readArtifact(path: string): Promise<unknown> {
  const bytes=await readBoundedBytes(path);
  try{return JSON.parse(bytes.toString("utf8"));}catch{throw new CliError("PLAN_ARTIFACT_INVALID","Artifact is not valid JSON.");}
}

export async function writeArtifact(artifact: CleanupPlan | OwnershipSnapshot, output: string, project: ProjectContext): Promise<string> {
  const checked="planVersion" in artifact ? parseCleanupPlan(artifact) : parseOwnershipSnapshot(artifact);
  const path=assertArtifactDestination(project,output);
  const root=project.workspace?.root ?? project.projectRoot;
  if(checked.project.root!==root||checked.project.selected!==localPath(root,project.projectRoot))throw new CliError("PLAN_PROJECT_MISMATCH","Write the artifact from the package that created it.");
  if("planVersion" in checked&&isWithin(root,path)&&!localPath(root,path).split("/").includes(".shadcn-plus")&&!checked.inputs.excludedArtifacts.includes(localPath(root,path)))throw new CliError("PLAN_OUTPUT_NOT_CAPTURED","Plan output must be declared during planning or stored under .shadcn-plus/plans.");
  const bytes=JSON.stringify(checked,null,2)+"\n";
  if(Buffer.byteLength(bytes)>64*1024*1024)throw new CliError("PLAN_ARTIFACT_INVALID","Artifact exceeds its size limit.");
  await mkdir(dirname(path),{recursive:true});
  const handle=await open(path,"wx",0o600).catch((error:NodeJS.ErrnoException)=>{throw new CliError(error.code==="EEXIST"?"PLAN_OUTPUT_EXISTS":"PLAN_OUTPUT_WRITE_FAILED","Could not exclusively create the requested artifact; no existing file was overwritten.");});
  try {await handle.writeFile(bytes,"utf8");await handle.sync();} finally {await handle.close();}
  return path;
}

export async function validateArtifactExclusions(plan:CleanupPlan,project:ProjectContext):Promise<void> {
  for(const excluded of plan.inputs.excludedArtifacts){
    const path=resolveLocal(plan.inputs.root,excluded);assertArtifactDestination(project,path,true);
    if(existsSync(path)){
      const artifact=parseCleanupPlan(await readArtifact(path));
      if(artifact.id!==plan.id)throw new CliError("PLAN_EXCLUSION_INVALID","An excluded output path contains a different artifact.");
    }
  }
}
