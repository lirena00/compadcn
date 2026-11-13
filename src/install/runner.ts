import { execa } from "execa";
import { join } from "node:path";
import { CliError } from "../core/errors.js";
import type { PackageManager } from "../utils/getUserPkgManager.js";

export function installInvocation(manager:PackageManager,addresses:string[],overwrite=false) {
  const args=["shadcn@4.23.0","add","--yes",...(overwrite?["--overwrite"]:[]),"--",...addresses];
  switch(manager) {
    case "pnpm":return {command:"pnpm",args:["dlx",...args]};
    case "yarn":return {command:"yarn",args:["dlx",...args]};
    case "bun":return {command:"bunx",args:["--bun",...args]};
    default:return {command:"npx",args:["--yes",...args]};
  }
}

export async function installSelected(options:{cwd:string;manager:PackageManager;addresses:string[];overwrite?:boolean;signal:AbortSignal;interactive:boolean}):Promise<void> {
  if(!options.addresses.length)throw new CliError("INVALID_ARGUMENT","Select at least one component before starting the installer.");
  const {command,args}=installInvocation(options.manager,options.addresses,options.overwrite);
  if(options.signal.aborted)throw new CliError("INSTALL_CANCELLED","Installation was cancelled before spawning its process.");
  const subprocess=execa(command,args,{cwd:options.cwd,cancelSignal:process.platform==="win32"?undefined:options.signal,forceKillAfterDelay:1000,reject:false,
    stdin:options.interactive?"inherit":"ignore",stdout:options.interactive?"inherit":"pipe",stderr:options.interactive?"inherit":"pipe",maxBuffer:4*1024*1024,
    env:options.interactive?process.env:{...process.env,CI:"1",NO_COLOR:"1"}});
  let termination:Promise<unknown>|undefined;
  const cancelTree=()=>{
    if(process.platform!=="win32"||termination||!subprocess.pid)return;
    // A package-manager .cmd wrapper has a Node descendant. Killing only the
    // wrapper can leave that installer writing files after cancellation.
    termination=execa(join(process.env.SystemRoot ?? "C:\\Windows","System32","taskkill.exe"),["/pid",String(subprocess.pid),"/t","/f"],
      {reject:false,stdio:"ignore",windowsHide:true}).then(()=>{subprocess.kill();});
  };
  options.signal.addEventListener("abort",cancelTree,{once:true});
  subprocess.once("spawn",()=>{if(options.signal.aborted)cancelTree();});
  if(options.signal.aborted)cancelTree();
  try {
    const result=await subprocess;
    await termination;
    if(result.failed||result.exitCode!==0)throw new CliError("INSTALL_FAILED",`The shadcn installer did not complete (exit ${result.exitCode ?? "unknown"}). Project files may have changed.`,{exitCode:result.exitCode ?? null});
  } finally {options.signal.removeEventListener("abort",cancelTree);}
}
