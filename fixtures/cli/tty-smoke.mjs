import { createProject } from "./project-fixture.mjs";
import { stubPackageManagers } from "./package-manager-stubs.mjs";
import { registryServer, json, catalog } from "../registry/server.mjs";
import { runCli } from "../../dist/index.js";
import { setTimeout as delay } from "node:timers/promises";

// Manual PTY verification using only generated projects and a local registry.
const mode=process.argv[2] ?? "add";
if(!["add","inventory"].includes(mode))throw new Error("Choose add or inventory");
const cleanup=[],t={after(fn){cleanup.push(fn);}};
const initialRawMode=process.stdin.isRaw;
try {
  const item={name:"menu",type:"registry:ui",description:"A menu from the local test registry",files:[{path:"ui/menu.tsx",type:"registry:ui",content:"export const Value=1;"}]};
  const server=await registryServer(t,async(req,res)=>{
    const controller=new AbortController();res.once("close",()=>controller.abort());
    try {await delay(mode==="inventory"?30000:250,undefined,{signal:controller.signal});} catch {return;}
    json(res,req.url.includes("registry.json")?catalog([item]):item);
  });
  const root=createProject(t,{"package.json":'{"packageManager":"npm@10.0.0","dependencies":{"react":"19"}}',
    "components.json":JSON.stringify({aliases:{ui:"./ui"},registries:{"@shadcn":`${server.url}/{name}.json`,"@company":`${server.url}/{name}.json`}})});
  Object.assign(process.env,stubPackageManagers(root));
  process.env.SHADCN_PLUS_WRITE_FILES=JSON.stringify({"ui/menu.tsx":"export const Value=1;"});
  process.exitCode=await runCli([process.execPath,"shadcn-plus",mode,"--cwd",root,"--no-cache",...process.argv.slice(3)]);
  console.log(JSON.stringify({exitCode:process.exitCode,initialRawMode,finalRawMode:process.stdin.isRaw}));
} finally {for(const fn of cleanup.reverse())await fn();}
