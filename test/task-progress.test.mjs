import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildInventory } from "../dist/inventory/build.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function fixture(t, handler) {
  const server = await registryServer(t, handler ?? ((_req,res)=>json(res,catalog([]))));
  const root = createProject(t,{"package.json":"{}","components.json":JSON.stringify({aliases:{ui:"./ui"},registries:{"@shadcn":{url:`${server.url}/{name}.json`,headers:{Authorization:"Bearer progress-secret"}}}})});
  return {root,server};
}

test("service progress reports real stages and source status without credentials", async(t)=>{
  const {root}=await fixture(t);
  const events=[];
  const report=await buildInventory({cwd:root,cacheDir:false,onProgress:(event)=>events.push(event)});
  assert.equal(report.complete,true,JSON.stringify(report.diagnostics));
  assert.ok(events.some(({stage,state})=>stage==="configuration"&&state==="start"));
  assert.ok(events.some(({stage,state})=>stage==="discovery"&&state==="complete"));
  assert.ok(events.some(({source})=>source?.status==="ready"&&source.cache.includes("network")));
  assert.equal(events.at(-1).completed,events.at(-1).total);
  assert.doesNotMatch(JSON.stringify(events),/progress-secret|http:\/\//);
});

test("opt-in plain progress stays on stderr while stdout remains one JSON response",async(t)=>{
  const {root}=await fixture(t);
  const env={...process.env,NO_COLOR:"1"};delete env.FORCE_COLOR;
  const result=await execute(process.execPath,[cli,"inventory","--json","--progress","--no-cache"],{cwd:root,env,encoding:"utf8",timeout:10000});
  assert.equal(JSON.parse(result.stdout).status,"completed");
  assert.match(result.stderr,/configuration start:/);
  assert.match(result.stderr,/@shadcn: ready/);
  assert.match(result.stderr,/network/);
  assert.doesNotMatch(result.stderr,/\u001b\[|progress-secret/);
  const silent=await execute(process.execPath,[cli,"inventory","--json","--no-progress","--no-cache"],{cwd:root,env,encoding:"utf8",timeout:10000});
  assert.equal(silent.stderr,"");
});

test("interrupting an in-flight CLI request returns cancellation and removes signal listeners",async(t)=>{
  let requested;
  const requestStarted=new Promise((resolve)=>{requested=resolve;});
  const {root}=await fixture(t,()=>requested());
  const script=fileURLToPath(new URL("../fixtures/cli/cancellable-command.mjs",import.meta.url));
  const child=fork(script,["inventory","--json","--no-cache"],{cwd:root,stdio:["ignore","pipe","pipe","ipc"]});
  let stdout="",stderr="",listeners;
  child.stdout.on("data",(chunk)=>{stdout+=chunk;});child.stderr.on("data",(chunk)=>{stderr+=chunk;});
  child.on("message",(message)=>{listeners=message;});
  const exited=new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code)=>resolve(code));});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await Promise.race([requestStarted,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error("CLI did not request catalog")),10000);timer.unref();})]);
  child.send("cancel");
  assert.equal(await exited,0,stderr);
  assert.equal(JSON.parse(stdout).status,"cancelled");
  assert.equal(stderr,"");
  assert.deepEqual(listeners.after,listeners.before);
});
