import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join,relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer,json,catalog } from "../fixtures/registry/server.mjs";

const execute=promisify(execFile),cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));
const blocker=new URL("../fixtures/cli/register-block-workflows.mjs",import.meta.url).href;
const analysisBlocker=new URL("../fixtures/cli/register-block-analysis.mjs",import.meta.url).href;
const content="export const Value=1;\n";
const item=(name)=>({name,type:"registry:ui",files:[{path:`ui/${name}.tsx`,type:"registry:ui",content}]});

async function fixture(t,extra={}){
  const server=await registryServer(t,(req,res)=>{
    const path=new URL(req.url,"http://local").pathname;
    const name=path.split("/").at(-1).replace(/\.json$/,"");
    const custom=path.startsWith("/private/");
    if(custom&&req.headers.authorization!=="Bearer cleanup-plan-private-secret"){res.writeHead(401);return res.end();}
    const items=[item(custom?"unused":"used")];
    if(name==="registry")return json(res,catalog(items));
    const value=items.find((value)=>value.name===name);if(value)return json(res,value);res.writeHead(404);res.end();
  });
  const root=createProject(t,{"package.json":'{"dependencies":{"vite":"7","react":"19"}}',"components.json":JSON.stringify({aliases:{ui:"./ui"},registries:{"@shadcn":`${server.url}/official/{name}.json`,"@company":{url:`${server.url}/private/{name}.json`,headers:{Authorization:"Bearer ${REGISTRY_TOKEN}"}}}}),
    "index.html":'<script type="module" src="/src/main.tsx"></script>',"src/main.tsx":'import {Value} from "../ui/used";console.log(Value);',"ui/used.tsx":content,"ui/unused.tsx":content,...extra});
  return {root,server,env:{...process.env,REGISTRY_TOKEN:"cleanup-plan-private-secret",NO_COLOR:"1",HOME:root,USERPROFILE:root}};
}

async function run(root,args,env={},imports=[blocker]){
  const settings={...env};delete settings.FORCE_COLOR;
  try{return {...await execute(process.execPath,[...imports.flatMap((value)=>["--import",value]),cli,...args],{cwd:root,env:settings,encoding:"utf8",timeout:30000,maxBuffer:16*1024*1024}),status:0};}
  catch(error){if(typeof error.code!=="number")throw error;return {stdout:error.stdout,stderr:error.stderr,status:error.code};}
}
function snapshot(root){return Object.fromEntries(readdirSync(root,{recursive:true,withFileTypes:true}).filter((entry)=>entry.isFile()).map((entry)=>{const path=join(entry.parentPath,entry.name);return [relative(root,path),readFileSync(path,"base64")];}).sort(([a],[b])=>a.localeCompare(b)));}

test("named JSON planning works without a terminal for private registries and changes no project files",async(t)=>{
  const {root,env}=await fixture(t);const before=snapshot(root);
  const result=await run(root,["plan","remove","@company/unused","--include-unverified","--json","--no-cache","--no-interactive"],env);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.stderr,"");
  const plan=JSON.parse(result.stdout).data.plan;assert.equal(plan.status,"ready");assert.deepEqual(plan.operations.map(({path})=>path),["ui/unused.tsx"]);
  assert.doesNotMatch(result.stdout,/cleanup-plan-private-secret/);assert.deepEqual(snapshot(root),before);
});

test("batch ownership review enables default pruning; exact artifacts and check are read-only",async(t)=>{
  const {root,env}=await fixture(t);const ownership=join(root,".shadcn-plus/ownership.json"),output=join(root,".shadcn-plus/plans/cleanup.json");
  const snap=await run(root,["plan","snapshot","--out",ownership,"--json","--no-cache"],env);
  assert.equal(snap.status,0,snap.stdout);assert.equal(JSON.parse(snap.stdout).data.ownership.items.length,2);
  const planned=await run(root,["plan","prune","--ownership",ownership,"--out",output,"--summary","--json","--no-cache"],env);
  assert.equal(planned.status,0,planned.stdout);const response=JSON.parse(planned.stdout).data;
  assert.equal(response.plan.counts.files,1);assert.equal(response.plan.operations,undefined);
  const artifact=JSON.parse(readFileSync(output,"utf8"));assert.equal(artifact.planVersion,1);assert.match(artifact.operations[0].diff,/-export const Value/);
  assert.equal(artifact.id,response.plan.id);
  const check=await run(root,["plan","check",output,"--json","--no-cache"],env);
  assert.equal(check.status,0,check.stdout);assert.equal(JSON.parse(check.stdout).data.valid,true);
  assert.equal(readFileSync(join(root,"ui/unused.tsx"),"utf8"),content);
});

test("blocked proposals preserve reasons and their requested artifact with exit 2",async(t)=>{
  const {root,env}=await fixture(t);const output=join(root,"blocked.json");
  const result=await run(root,["plan","prune","--out",output,"--json","--no-cache"],env);
  assert.equal(result.status,2);assert.equal(result.stderr,"");assert.equal(JSON.parse(result.stdout).error.code,"PLAN_BLOCKED");
  const plan=JSON.parse(readFileSync(output,"utf8"));assert.equal(plan.status,"blocked");assert.equal(plan.operations.length,0);
  assert.ok(plan.excluded.some(({reasons})=>reasons.includes("OWNERSHIP_UNVERIFIED")));
  const again=await run(root,["plan","prune","--out",output,"--json","--no-cache"],env);
  assert.equal(again.status,2);assert.equal(JSON.parse(again.stdout).error.code,"PLAN_OUTPUT_EXISTS");
});

test("plain plans show exact deletions; incomplete plans keep source diagnostics on stderr",async(t)=>{
  const {root,env}=await fixture(t);
  const good=await run(root,["plan","remove","@company/unused","--include-unverified","--plain","--no-cache"],env);
  assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/DELETE ui\/unused.tsx/);assert.match(good.stdout,/\+\+\+ \/dev\/null/);assert.doesNotMatch(good.stdout,/\u001b\[/);
  writeFileSync(join(root,"src/computed.ts"),'import(process.env.COMPONENT);');
  const partial=await run(root,["plan","remove","@company/unused","--include-unverified","--plain","--no-cache"],env);
  assert.equal(partial.status,2);assert.equal(partial.stdout,"");assert.match(partial.stderr,/^ERROR PLAN_INCOMPLETE:/);assert.match(partial.stderr,/SOURCE_COMPUTED_REFERENCE/);
});

test("new consumers invalidate a saved plan without fetching registries or changing its artifact",async(t)=>{
  const {root,env,server}=await fixture(t);const output=join(root,"plan.json");
  const planned=await run(root,["plan","remove","@company/unused","--include-unverified","--out",output,"--json","--no-cache"],env);
  assert.equal(planned.status,0,planned.stdout);const bytes=readFileSync(output,"utf8"),requests=server.requests.length;
  writeFileSync(join(root,"src/new-consumer.tsx"),'import "../ui/unused";');
  const checked=await run(root,["plan","check",output,"--json","--no-cache"],env);
  assert.equal(checked.status,2);assert.equal(JSON.parse(checked.stdout).error.code,"PLAN_STALE");
  assert.ok(JSON.parse(checked.stdout).error.details.check.diagnostics.some(({code})=>code==="PLAN_INPUT_ADDED"));
  assert.equal(server.requests.length,requests);assert.equal(readFileSync(output,"utf8"),bytes);
});

test("invalid planning flags and protected output paths fail before requests",async(t)=>{
  const {root,env,server}=await fixture(t);
  for(const args of [["plan","remove"],["plan","prune","--include-unverified"],["plan","prune","--max-input-files","0"],["plan","prune","--max-input-bytes","0"],["plan","prune","--verify-script","bad;script"],["plan","prune","--out","package.json"]]){
    const result=await run(root,[...args,"--json"],env);assert.equal(result.status,2,result.stdout);
  }
  assert.equal(server.requests.length,0);assert.equal(JSON.parse(readFileSync(join(root,"package.json"),"utf8")).dependencies.react,"19");
});

test("plan help and API import never initialize planning libraries or analysis engines",async(t)=>{
  const {root,env,server}=await fixture(t);
  for(const args of [["plan"],["plan","prune","--help"],["plan","snapshot","--help"],["plan","remove","--help"],["plan","check","--help"]]){
    const result=await run(root,["--json",...args],env,[blocker,analysisBlocker]);assert.equal(result.status,0,result.stderr);assert.match(JSON.parse(result.stdout).data.help,/Usage: shadcn-plus plan/);
  }
  const entry=new URL("../dist/index.js",import.meta.url).href;
  const script=`const api=await import(${JSON.stringify(entry)});for(const key of ['createCleanupPlan','createOwnershipSnapshot','checkCleanupPlan','parseCleanupPlan'])if(typeof api[key]!=='function')throw new Error('Missing '+key);console.log('imported');`;
  const result=await execute(process.execPath,["--import",blocker,"--import",analysisBlocker,"--input-type=module","--eval",script],{cwd:root,encoding:"utf8",timeout:10000});
  assert.equal(result.stdout,"imported\n");assert.equal(result.stderr,"");assert.equal(server.requests.length,0);
});

test("explicit verification script flags pin required package scripts without running them",async(t)=>{
  const {root,env}=await fixture(t,{"package.json":'{"dependencies":{"vite":"7","react":"19"},"scripts":{"build":"echo private-verification-script"}}'});
  const ready=await run(root,["plan","remove","@company/unused","--include-unverified","--verify-script","build","--json","--no-cache"],env);
  assert.equal(ready.status,0,ready.stdout);
  const steps=JSON.parse(ready.stdout).data.plan.verification;assert.equal(steps.length,1);assert.equal(steps[0].required,true);assert.deepEqual(steps[0].args,["run","build"]);
  assert.doesNotMatch(ready.stdout,/private-verification-script/);
  const missing=await run(root,["plan","remove","@company/unused","--include-unverified","--verify-script","missing","--json","--no-cache"],env);
  assert.equal(missing.status,2);assert.equal(JSON.parse(missing.stdout).error.code,"PLAN_INCOMPLETE");
});

test("offline revalidation reuses credential-scoped metadata without network requests",async(t)=>{
  const {root,env,server}=await fixture(t),cache=createProject(t),output=join(root,"plan.json");
  const planned=await run(root,["plan","remove","@company/unused","--include-unverified","--out",output,"--cache-dir",cache,"--json"],env);
  assert.equal(planned.status,0,planned.stdout);const count=server.requests.length;
  const checked=await run(root,["plan","check",output,"--offline","--cache-dir",cache,"--json"],env);
  assert.equal(checked.status,0,checked.stdout);assert.equal(JSON.parse(checked.stdout).data.ready,true);assert.equal(server.requests.length,count);
});
