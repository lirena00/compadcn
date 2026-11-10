import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const execute=promisify(execFile);
const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));
const blocker=new URL("../fixtures/cli/register-block-workflows.mjs",import.meta.url).href;
const analysisBlocker=new URL("../fixtures/cli/register-block-analysis.mjs",import.meta.url).href;
const terminal=new URL("../fixtures/cli/simulate-terminal.mjs",import.meta.url).href;
const item=(name)=>({name,type:"registry:ui",files:[{path:`ui/${name}.tsx`,type:"registry:ui",content:"export const Value=1;"}]});

async function fixture(t,extra={}) {
  const items=[item("button"),item("unused")];
  const server=await registryServer(t,(req,res)=>json(res,req.url.includes("registry.json")?catalog(items):items.find(({name})=>req.url.includes(`${name}.json`))));
  const root=createProject(t,{"package.json":'{"dependencies":{"react":"19","vite":"7"}}',
    "components.json":JSON.stringify({aliases:{ui:"./ui"},registries:{"@shadcn":`${server.url}/{name}.json`,"@custom":`${server.url}/{name}.json`}}),
    "index.html":'<script type="module" src="/src/main.tsx"></script>',"src/main.tsx":'import {Value} from "../ui/button";console.log(Value);',
    "ui/button.tsx":"export const Value=1;","ui/unused.tsx":"export const Value=1;",...extra});
  return {root,server};
}

async function run(cwd,args,imports=[blocker]) {
  const env={...process.env,NO_COLOR:"1",HOME:cwd,USERPROFILE:cwd};delete env.FORCE_COLOR;
  try {
    return {...await execute(process.execPath,[...imports.flatMap((value)=>["--import",value]),cli,...args],{cwd,env,encoding:"utf8",timeout:30000,maxBuffer:16*1024*1024}),status:0};
  } catch(error) {
    if(typeof error.code!=="number")throw error;
    return {stdout:error.stdout,stderr:error.stderr,status:error.code};
  }
}

function snapshot(root) {
  return Object.fromEntries(readdirSync(root,{recursive:true,withFileTypes:true}).filter((entry)=>entry.isFile()).map((entry)=>{
    const path=join(entry.parentPath,entry.name);return [relative(root,path),readFileSync(path,"base64")];
  }).sort(([a],[b])=>a.localeCompare(b)));
}

for(const flags of [[],["--plain"],["--json","--no-interactive"]]) {
  test(`audit supports noninteractive output: ${flags.join(" ") || "default"}`,async(t)=>{
    const {root}=await fixture(t);
    const result=await run(root,["audit","--no-cache",...flags]);
    assert.equal(result.status,0,result.stderr || result.stdout);
    assert.equal(result.stderr,"");
    if(flags.includes("--json")) {
      const response=JSON.parse(result.stdout);
      assert.equal(response.status,"completed");
      assert.equal(response.data.auditVersion,1);
      assert.equal(response.data.counts.runtime,1);
      assert.equal(response.data.counts.unusedCandidates,1);
      assert.equal(response.data.files.length,2);
    } else {
      assert.match(result.stdout,/unused-candidate=1/);
      assert.match(result.stdout,/Read-only audit/);
      assert.doesNotMatch(result.stdout,/\u001b\[/);
    }
  });
}

test("JSON summary is a smaller projection with the same snapshot and coverage",async(t)=>{
  const {root}=await fixture(t);
  const full=await run(root,["audit","--json","--no-cache"]);
  const compact=await run(root,["--json","audit","--summary","--no-cache"],[terminal,blocker]);
  assert.equal(full.status,0,full.stdout);
  assert.equal(compact.status,0,compact.stdout);
  const report=JSON.parse(full.stdout).data,summary=JSON.parse(compact.stdout).data;
  assert.equal(summary.snapshotId,report.snapshotId);
  assert.deepEqual(summary.counts,report.counts);
  assert.deepEqual(summary.coverage,report.coverage);
  assert.equal(summary.rootCount,report.roots.length);
  assert.equal(summary.files,undefined);
  assert.equal(summary.items,undefined);
  assert.ok(compact.stdout.length<full.stdout.length);
  assert.equal(compact.stderr,"");
});

test("why explains custom items and file consumers without prompting",async(t)=>{
  const {root}=await fixture(t);
  const result=await run(root,["why","@custom/button","--json","--no-cache"]);
  assert.equal(result.status,0,result.stdout);
  const why=JSON.parse(result.stdout).data;
  assert.equal(why.target.kind,"item");
  assert.equal(why.target.finding.usage,"runtime");
  assert.equal(why.target.finding.proof.path.at(-1).line,1);
  const file=await run(root,["why","ui/button.tsx","--plain","--no-cache"]);
  assert.equal(file.status,0,file.stderr);
  assert.match(file.stdout,/Consumer: .*main.tsx:1:/);
  assert.match(file.stdout,/Cleanup eligible: false/);
});

test("partial audit and why use exit 2 with evidence in one JSON envelope",async(t)=>{
  const {root}=await fixture(t,{"src/computed.ts":"import(process.env.COMPONENT);"});
  for(const args of [["audit","--summary"],["why","@custom/button"]]) {
    const result=await run(root,[...args,"--json","--no-cache"]);
    assert.equal(result.status,2);
    assert.equal(result.stderr,"");
    const response=JSON.parse(result.stdout);
    assert.equal(response.error.code,"AUDIT_INCOMPLETE");
    const partial=response.error.details.audit ?? response.error.details.why;
    assert.equal(partial.coverage.graph,false);
    assert.equal(partial.complete,false);
    if(args[0]==="audit")assert.equal(partial.counts.unusedCandidates,0);
    else assert.equal(partial.target.finding.usage,"runtime");
  }
  const plain=await run(root,["audit","--plain","--no-cache"]);
  assert.equal(plain.status,2);
  assert.equal(plain.stdout,"");
  assert.match(plain.stderr,/^ERROR AUDIT_INCOMPLETE:/);
});

test("entry overrides resolve custom policy and empty matches remain incomplete",async(t)=>{
  const {root}=await fixture(t,{"vite.config.ts":"export default (()=>({}))();"});
  const explicit=await run(root,["audit","--entry","src/main.tsx","--dev-entry","vite.config.ts","--json","--no-cache"]);
  assert.equal(explicit.status,0,explicit.stdout);
  const missing=await run(root,["audit","--entry","missing.tsx","--json","--no-cache"]);
  assert.equal(missing.status,2);
  assert.ok(JSON.parse(missing.stdout).error.details.audit.diagnostics.some(({code})=>code==="ENTRY_PATTERN_EMPTY"));
});

test("audit validates options before requests and offline why preserves every project file",async(t)=>{
  const {root,server}=await fixture(t);
  const before=snapshot(root);
  for(const flags of [["--analysis-timeout","0"],["--entry","../outside.ts"],["--dev-entry","!only-negative.ts"],["--max-items","0"],["--max-files","0"],["--offline","--refresh"],["--no-cache","--cache-dir","other"]]) {
    const result=await run(root,["audit","--json",...flags]);
    assert.equal(result.status,2,result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code,"INVALID_OPTIONS");
  }
  assert.equal(server.requests.length,0);
  const cache=createProject(t);
  const good=await run(root,["audit","--json","--cache-dir",cache]);
  assert.equal(good.status,0,good.stdout);
  const requests=server.requests.length;
  const offline=await run(root,["why","@custom/button","--json","--offline","--cache-dir",cache]);
  assert.equal(offline.status,0,offline.stdout);
  assert.equal(server.requests.length,requests);
  assert.deepEqual(snapshot(root),before);
  const absent=await run(root,["why","not-installed","--json","--offline","--cache-dir",cache]);
  assert.equal(absent.status,2);
  assert.equal(JSON.parse(absent.stdout).error.code,"WHY_NOT_FOUND");
});

test("audit/why help and public API imports stay lazy with all analysis engines blocked",async(t)=>{
  const {root,server}=await fixture(t);
  for(const name of ["audit","why"]) {
    const result=await run(root,["--json",name,"--help"],[blocker,analysisBlocker]);
    assert.equal(result.status,0,result.stderr);
    assert.match(JSON.parse(result.stdout).data.help,/--entry <pattern>/);
    assert.match(JSON.parse(result.stdout).data.help,/--analysis-timeout/);
  }
  const entry=new URL("../dist/index.js",import.meta.url).href;
  const script=`const api=await import(${JSON.stringify(entry)});if(typeof api.auditProject!=='function'||typeof api.explainAudit!=='function')throw new Error('Missing audit API');console.log('imported');`;
  const result=await execute(process.execPath,["--import",blocker,"--import",analysisBlocker,"--input-type=module","--eval",script],{cwd:root,encoding:"utf8",timeout:10000});
  assert.equal(result.stdout,"imported\n");
  assert.equal(result.stderr,"");
  assert.equal(server.requests.length,0);
});
