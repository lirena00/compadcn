import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { stubPackageManagers } from "../fixtures/cli/package-manager-stubs.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";
import { installInvocation } from "../dist/install/runner.js";

const execute=promisify(execFile);
const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));
const blocker=new URL("../fixtures/cli/register-block-workflows.mjs",import.meta.url).href;
const analysisBlocker=new URL("../fixtures/cli/register-block-analysis.mjs",import.meta.url).href;
const terminal=new URL("../fixtures/cli/simulate-terminal.mjs",import.meta.url).href;
const content="export const Value=1;";
const item=(name,custom=false)=>({name,type:"registry:ui",description:"Dialog and menu primitives",files:[{path:`ui/${name}.tsx`,type:"registry:ui",content,...(custom&&name==="dialog"?{target:"~/private/dialog.tsx"}:{})}]});

async function fixture(t,{broken=false,files={},manager="npm"}={}){
  const server=await registryServer(t,(req,res)=>{
    const path=new URL(req.url,"http://local").pathname,custom=path.startsWith("/custom/");
    if(broken&&custom){res.writeHead(401);return res.end();}
    const name=path.split("/").at(-1).replace(/\.json$/,"");
    const values=[item("dialog",custom),item("menu",custom),{...item("account"),type:"registry:block"}];
    if(name==="registry")return json(res,catalog(values));
    const found=values.find((item)=>item.name===name);
    if(found)return json(res,found);
    res.writeHead(404);res.end();
  });
  const root=createProject(t,{"package.json":JSON.stringify({packageManager:`${manager}@10.0.0`,dependencies:{react:"19",vite:"7"}}),
    "components.json":JSON.stringify({aliases:{ui:"./ui",components:"./components"},registries:{"@shadcn":`${server.url}/official/{name}.json`,"@company":{url:`${server.url}/custom/{name}.json`,headers:{Authorization:"Bearer ${REGISTRY_TOKEN}"}}}}),
    "ui/dialog.tsx":content,...files});
  const env={...stubPackageManagers(root),REGISTRY_TOKEN:"catalog-test-secret"};
  return {root,server,env};
}

async function run(root,args,env={},imports=[blocker]){
  try{return {...await execute(process.execPath,[...imports.flatMap((value)=>["--import",value]),cli,...args],{cwd:root,env:{...process.env,...env},encoding:"utf8",timeout:20000,maxBuffer:8*1024*1024}),status:0};}
  catch(error){if(typeof error.code!=="number")throw error;return {stdout:error.stdout,stderr:error.stderr,status:error.code};}
}

function snapshot(root){return Object.fromEntries(readdirSync(root,{recursive:true,withFileTypes:true}).filter((entry)=>entry.isFile()).map((entry)=>{const path=join(entry.parentPath,entry.name);return [relative(root,path),readFileSync(path,"base64")];}).sort(([a],[b])=>a.localeCompare(b)));}

test("search distinguishes namespaced collisions, observed local files, types and descriptions",async(t)=>{
  const {root,env,server}=await fixture(t);
  const before=snapshot(root);
  const result=await run(root,["search","DIALOG","--json","--no-cache"],env);
  assert.equal(result.status,0,result.stdout);
  const report=JSON.parse(result.stdout).data;
  assert.equal(report.entries.length,6);
  assert.equal(report.entries.find(({address})=>address==="@shadcn/dialog").presence,"present");
  assert.equal(report.entries.find(({address})=>address==="@company/dialog").presence,"absent");
  assert.ok(server.requests.some(({headers})=>headers.authorization==="Bearer catalog-test-secret"));
  assert.doesNotMatch(result.stdout+result.stderr,/catalog-test-secret/);
  assert.deepEqual(snapshot(root),before);
  const filtered=await run(root,["search","menu","--registry","@company","--type","ui","--presence","absent","--limit","1","--json","--no-cache"],env);
  assert.equal(filtered.status,0,filtered.stdout);
  const view=JSON.parse(filtered.stdout).data;
  assert.equal(view.entries.length,1);assert.equal(view.matchedEntries,2);assert.equal(view.omittedEntries,1);
  assert.equal(view.entries[0].namespace,"@company");
});

test("partial catalog search retains healthy entries and reports failure in plain and JSON",async(t)=>{
  const {root,env}=await fixture(t,{broken:true});
  const json=await run(root,["search","--json","--no-cache"],env);
  assert.equal(json.status,2);assert.equal(json.stderr,"");
  const report=JSON.parse(json.stdout).error.details.catalog;
  assert.equal(report.complete,false);assert.ok(report.entries.length>0);
  assert.ok(report.sources.some(({status})=>status==="error"));
  const plain=await run(root,["search","--plain","--no-cache"],env);
  assert.equal(plain.status,2);assert.equal(plain.stdout,"");assert.match(plain.stderr,/Catalog search incomplete/);
});

test("search reuses offline cache and rejects invalid filters before requests",async(t)=>{
  const {root,env,server}=await fixture(t),cache=createProject(t);
  for(const flags of [["--limit","0"],["--presence","installed"],["--registry","company"],["--type","ui;unsafe"]]){
    const result=await run(root,["search","--json",...flags],env);
    assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).error.code,"INVALID_OPTIONS");
  }
  assert.equal(server.requests.length,0);
  assert.equal((await run(root,["search","--json","--cache-dir",cache],env)).status,0);
  const count=server.requests.length;
  const offline=await run(root,["search","--json","--offline","--cache-dir",cache],env);
  assert.equal(offline.status,0,offline.stdout);assert.equal(server.requests.length,count);
});

for(const manager of ["npm","pnpm","yarn","bun"]){
  test(`explicit ${manager} add preserves qualified addresses, suppresses prompts and verifies files`,async(t)=>{
    const {root,env}=await fixture(t,{manager});
    env.SHADCN_PLUS_WRITE_FILES=JSON.stringify({"private/dialog.tsx":content});
    const result=await run(root,["add","@company/dialog","--yes","--json","--no-cache"],env);
    assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.stderr,"");
    const report=JSON.parse(result.stdout).data;
    assert.deepEqual(report.installed,["@company/dialog"]);assert.equal(report.verifiedFiles,1);
    const invocation=JSON.parse(readFileSync(env.SHADCN_PLUS_ARGS_FILE,"utf8"));
    assert.deepEqual({command:invocation.command,args:invocation.args},installInvocation(manager,["@company/dialog"]));
    assert.equal(invocation.cwd,root);assert.equal(readFileSync(join(root,"ui/dialog.tsx"),"utf8"),content);
    assert.doesNotMatch(result.stdout,/Simulated package-manager output/);
  });
}

test("an explicit observed item is skipped unless overwrite is requested",async(t)=>{
  const {root,env}=await fixture(t);
  const result=await run(root,["add","dialog","--yes","--json","--no-cache"],env);
  assert.equal(result.status,0,result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).data.skipped,["@shadcn/dialog"]);
  assert.equal(existsSync(env.SHADCN_PLUS_ARGS_FILE),false);
  env.SHADCN_PLUS_WRITE_FILES=JSON.stringify({"ui/dialog.tsx":"updated"});
  const overwritten=await run(root,["add","dialog","--overwrite","--yes","--json","--no-cache"],env);
  assert.equal(overwritten.status,0,overwritten.stdout);
  assert.ok(JSON.parse(readFileSync(env.SHADCN_PLUS_ARGS_FILE,"utf8")).args.includes("--overwrite"));
});

test("installer failure and a successful no-op cannot claim verified installation",async(t)=>{
  const {root,env}=await fixture(t);
  const failed=await run(root,["add","@company/dialog","--yes","--json","--no-cache"],{...env,SHADCN_PLUS_PM_EXIT:"7"});
  assert.equal(failed.status,2);assert.equal(JSON.parse(failed.stdout).error.code,"INSTALL_FAILED");
  assert.doesNotMatch(failed.stdout,/catalog-test-secret|Simulated/);
  const noop=await run(root,["add","@company/dialog","--yes","--json","--no-cache"],env);
  assert.equal(noop.status,2);assert.equal(JSON.parse(noop.stdout).error.code,"INSTALL_VERIFICATION_FAILED");
});

test("interrupting a started installer reports partial-write risk instead of normal cancellation",async(t)=>{
  const {root,env}=await fixture(t);
  const script=fileURLToPath(new URL("../fixtures/cli/cancellable-command.mjs",import.meta.url));
  const child=fork(script,["add","@company/dialog","--yes","--json","--no-cache"],{cwd:root,env:{...env,SHADCN_PLUS_WRITE_FILES:JSON.stringify({"private/dialog.tsx":content}),SHADCN_PLUS_PM_DELAY_MS:"3000"},stdio:["ignore","pipe","pipe","ipc"]});
  let stdout="",stderr="";child.stdout.on("data",(chunk)=>{stdout+=chunk;});child.stderr.on("data",(chunk)=>{stderr+=chunk;});
  const exited=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code)=>resolve(code));});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const started=Date.now();
  while(!existsSync(join(root,"private/dialog.tsx"))){if(Date.now()-started>10000)throw new Error("Installer did not start");await new Promise((resolve)=>setTimeout(resolve,20));}
  const installerPid=JSON.parse(readFileSync(env.SHADCN_PLUS_ARGS_FILE,"utf8")).pid;
  child.send("cancel");
  assert.equal(await exited,2,stderr);
  const result=JSON.parse(stdout);
  assert.equal(result.status,"error");assert.equal(result.error.code,"INSTALL_INTERRUPTED");
  assert.match(result.error.message,/may have changed/);
  assert.equal(readFileSync(join(root,"private/dialog.tsx"),"utf8"),content);
  assert.throws(()=>process.kill(installerPid,0),{code:"ESRCH"},"The package-manager descendant must also have stopped");
});

test("interactive add selects a custom item from the combined catalog and can use a healthy source during partial coverage",async(t)=>{
  const {root,env,server}=await fixture(t);
  env.SHADCN_PLUS_WRITE_FILES=JSON.stringify({"private/dialog.tsx":content});env.SHADCN_PLUS_PICK_ADDRESS="@company/dialog";
  const result=await run(root,["add","--registry","@company","--type","ui","--no-cache","--no-progress"],env,[terminal]);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Added @company\/dialog/);
  assert.equal(server.requests.filter(({path})=>path.includes("registry.json")).length,2);
  const broken=await fixture(t,{broken:true});broken.env.SHADCN_PLUS_WRITE_FILES=JSON.stringify({"ui/menu.tsx":content});
  const healthy=await run(broken.root,["add","@shadcn/menu","--yes","--json","--no-cache"],broken.env);
  assert.equal(healthy.status,0,healthy.stdout);assert.deepEqual(JSON.parse(healthy.stdout).data.installed,["@shadcn/menu"]);
});

for(const cancel of ["SHADCN_PLUS_CANCEL_PICKER","SHADCN_PLUS_CANCEL","SHADCN_PLUS_DECLINE"]){
  test(`${cancel} leaves project files unchanged and never starts the installer`,async(t)=>{
    const {root,env}=await fixture(t);const before=snapshot(root);
    const result=await run(root,["add",...(cancel==="SHADCN_PLUS_CANCEL_PICKER"?[]:["@company/dialog"]),"--no-cache","--no-progress"],{...env,[cancel]:"1"},[terminal]);
    assert.equal(result.status,0,result.stderr);assert.equal(existsSync(env.SHADCN_PLUS_ARGS_FILE),false);
    assert.deepEqual(snapshot(root),before);assert.match(result.stdout,/cancelled/i);
  });
}

test("missing items and unsupported requests fail before starting an installer",async(t)=>{
  const {root,env}=await fixture(t);
  const absent=await run(root,["add","missing","--yes","--json","--no-cache"],env);
  assert.equal(absent.status,2);assert.equal(JSON.parse(absent.stdout).error.code,"COMPONENT_NOT_FOUND");
  const invalid=await run(root,["add","@company/../escape","--yes","--json"],env);
  assert.equal(invalid.status,2);assert.equal(JSON.parse(invalid.stdout).error.code,"INVALID_ARGUMENT");
  assert.equal(existsSync(env.SHADCN_PLUS_ARGS_FILE),false);
});

test("TERM=dumb add requires explicit --yes and help/API imports stay lazy",async(t)=>{
  const {root,env,server}=await fixture(t);
  const plain=await run(root,["add","@company/dialog","--json"],env);
  assert.equal(plain.status,2);assert.equal(JSON.parse(plain.stdout).error.code,"INTERACTIVE_REQUIRED");
  for(const command of ["add","search"]){
    const help=await run(root,["--json",command,"--help"],env,[blocker,analysisBlocker]);
    assert.equal(help.status,0,help.stderr);assert.match(JSON.parse(help.stdout).data.help,/--registry/);
  }
  const entry=new URL("../dist/index.js",import.meta.url).href;
  const result=await execute(process.execPath,["--import",blocker,"--import",analysisBlocker,"--input-type=module","--eval",`const api=await import(${JSON.stringify(entry)});if(typeof api.searchCatalog!=='function')throw new Error('Missing API');console.log('imported');`],{cwd:root,encoding:"utf8",timeout:10000});
  assert.equal(result.stdout,"imported\n");assert.equal(server.requests.length,0);
});
