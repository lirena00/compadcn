import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createOwnershipSnapshot } from "../dist/changes/ownership.js";
import { createCleanupPlan } from "../dist/changes/build.js";
import { checkCleanupPlan } from "../dist/changes/check.js";
import { parseCleanupPlan, withId } from "../dist/changes/schema.js";
import { writeArtifact, readArtifact } from "../dist/changes/io.js";
import { discoverProject } from "../dist/project/discover.js";
import { deletionDiff } from "../dist/changes/diff.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer,json,catalog } from "../fixtures/registry/server.mjs";

const content="export const Value=1;\n";
const item=(name,extra={})=>({name,type:"registry:ui",files:[{path:`ui/${name}.tsx`,type:"registry:ui",content}],...extra});
async function fixture(t,values=[item("used"),item("unused")],extra={}){
  const server=await registryServer(t,(req,res)=>{
    const name=new URL(req.url,"http://local").pathname.split("/").at(-1).replace(/\.json$/,"");
    if(name==="registry")return json(res,catalog(values));
    const value=values.find((value)=>value.name===name);if(value)return json(res,value);res.writeHead(404);res.end();
  });
  const overrides=typeof extra==="function"?extra(server.url):extra;
  const root=createProject(t,Object.fromEntries(Object.entries({"package.json":'{"dependencies":{"vite":"7","react":"19"},"scripts":{"typecheck":"echo verification-marker-secret","build":"echo build"}}',
    "components.json":JSON.stringify({aliases:{ui:"./ui",components:"./components",hooks:"./hooks"},registries:{"@shadcn":`${server.url}/{name}.json`,"@custom":`${server.url}/{name}.json`}}),
    "index.html":'<script type="module" src="/src/main.tsx"></script>',"src/main.tsx":'import {Value} from "../ui/used";console.log(Value);',
    "ui/used.tsx":content,"ui/unused.tsx":content,...overrides}).filter(([,value])=>value!==null)));
  const options={cwd:root,cacheDir:false};return {root,server,options};
}

test("default prune retains unverified ownership; a reviewed snapshot enables exact read-only deletions",async(t)=>{
  const {root,options}=await fixture(t);
  const unverified=await createCleanupPlan(options);
  assert.equal(unverified.status,"blocked",JSON.stringify(unverified.diagnostics));
  assert.ok(unverified.excluded.some(({reasons})=>reasons.includes("OWNERSHIP_UNVERIFIED")));
  const ownership=await createOwnershipSnapshot(options);assert.equal(ownership.complete,true,JSON.stringify(ownership.diagnostics));assert.equal(ownership.items.length,2);
  const plan=await createCleanupPlan({...options,ownership});
  assert.equal(plan.status,"ready",JSON.stringify(plan.diagnostics));assert.deepEqual(plan.operations.map(({path})=>path),["ui/unused.tsx"]);
  assert.match(plan.operations[0].diff,/-export const Value=1;/);assert.equal(plan.operations[0].after.exists,false);
  assert.ok(plan.excluded.some(({reasons})=>reasons.includes("USAGE_RETAINED")));
  assert.equal(plan.verification.find(({script})=>script==="lint").status,"not-configured");
  assert.equal(plan.verification.find(({script})=>script==="typecheck").required,true);
  assert.doesNotMatch(JSON.stringify(plan),/verification-marker-secret/);
  assert.equal(readFileSync(join(root,"ui/unused.tsx"),"utf8"),content);
  assert.equal((await checkCleanupPlan(plan,options)).valid,true);
});

test("named plans allow an explicit observed mapping but never waive runtime usage",async(t)=>{
  const {options}=await fixture(t);
  const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true});
  assert.equal(plan.status,"ready",JSON.stringify(plan.diagnostics));assert.equal(plan.selected[0].ownership,"explicit-unverified");
  const used=await createCleanupPlan({...options,mode:"remove",targets:["@custom/used","@custom/unused"],includeUnverified:true});
  assert.equal(used.status,"blocked");assert.equal(used.operations.length,0);assert.ok(used.excluded.some(({reasons})=>reasons.includes("USAGE_RETAINED")));
});

test("modified files are excluded from automatic pruning and require named inclusion",async(t)=>{
  const {root,options}=await fixture(t);const ownership=await createOwnershipSnapshot(options);
  writeFileSync(join(root,"ui/unused.tsx"),"// customization\n"+content);
  const automatic=await createCleanupPlan({...options,ownership});
  assert.equal(automatic.status,"blocked");assert.ok(automatic.excluded.some(({reasons})=>reasons.includes("MODIFIED_SINCE_SNAPSHOT")));
  const named=await createCleanupPlan({...options,ownership,mode:"remove",targets:["@custom/unused"],includeModified:true});
  assert.equal(named.status,"ready",JSON.stringify(named.diagnostics));assert.equal(named.selected[0].modified,true);assert.match(named.operations[0].diff,/-\/\/ customization/);
});

test("orphan cycles can be removed together but retained dead-code consumers block partial sets",async(t)=>{
  const {root,options}=await fixture(t,[item("used"),item("a"),item("b")],{"ui/a.tsx":'import "./b";export const A=1;',"ui/b.tsx":'import "./a";export const B=1;'});
  const ownership=await createOwnershipSnapshot(options);
  const all=await createCleanupPlan({...options,ownership});assert.equal(all.status,"ready",JSON.stringify(all.diagnostics));assert.deepEqual(all.operations.map(({path})=>path),["ui/a.tsx","ui/b.tsx"]);
  const one=await createCleanupPlan({...options,ownership,mode:"remove",targets:["@custom/a"]});
  assert.equal(one.status,"blocked");assert.ok(one.excluded[0].reasons.includes("SOURCE_CONSUMER_RETAINED"));
  writeFileSync(join(root,"src/dead.ts"),'import "../ui/b";');
  const retained=await createCleanupPlan({...options,ownership});assert.equal(retained.status,"blocked");assert.equal(retained.operations.length,0);
});

test("registry-declared dependents and shared effects remain protected without invented import use",async(t)=>{
  const {options}=await fixture(t,[item("used",{registryDependencies:["@custom/unused"]}),item("unused"),item("effect",{cssVars:{light:{brand:"red"}}})],{"ui/effect.tsx":content});
  const ownership=await createOwnershipSnapshot(options),plan=await createCleanupPlan({...options,ownership});
  assert.equal(plan.operations.length,0);assert.ok(plan.excluded.some(({reasons})=>reasons.includes("REGISTRY_DEPENDENT_RETAINED")));
  assert.ok(plan.retained.resources.some(({kind})=>kind==="registry-cssVars"||kind==="cssVars"));
});

test("new consumers, metadata and scope changes invalidate saved plans before analysis",async(t)=>{
  const {root,server,options}=await fixture(t);const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true});
  const requests=server.requests.length;writeFileSync(join(root,"src/new.tsx"),'import "../ui/unused";');
  const checked=await checkCleanupPlan(plan,options);assert.equal(checked.valid,false);assert.ok(checked.diagnostics.some(({code,path})=>code==="PLAN_INPUT_ADDED"&&path==="src/new.tsx"));assert.equal(server.requests.length,requests);
});

test("artifact creation is exclusive, self-excluded, and fresh after writing",async(t)=>{
  const {root,options}=await fixture(t),output=join(root,"cleanup-plan.json");
  const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true,artifactPath:output});
  await writeArtifact(plan,output,discoverProject(options));assert.equal(existsSync(output),true);
  const read=parseCleanupPlan(await readArtifact(output));assert.equal(read.id,plan.id);
  assert.equal((await checkCleanupPlan(read,options)).valid,true);
  await assert.rejects(writeArtifact(plan,output,discoverProject(options)),{code:"PLAN_OUTPUT_EXISTS"});
  await assert.rejects(createCleanupPlan({...options,artifactPath:join(root,"package.json")}),{code:"PLAN_OUTPUT_INVALID"});
  await assert.rejects(createCleanupPlan({...options,artifactPath:join(root,"ui/review.json")}),{code:"PLAN_OUTPUT_MANAGED"});
});

test("tampering with operations or preview bytes fails even if an artifact ID is recomputed",async(t)=>{
  const {options}=await fixture(t);const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true});
  const {id,...body}=plan;
  const operation=plan.operations[0];
  assert.throws(()=>parseCleanupPlan(withId({...body,operations:[{...operation,path:"../escape.ts"}]})),{code:"PLAN_INVALID"});
  const {id:operationId,...operationBody}=operation;
  assert.throws(()=>parseCleanupPlan(withId({...body,operations:[withId({...operationBody,diff:operation.diff.replace("Value=1","Value=2")})]})),{code:"PLAN_PREVIEW_INVALID"});
});

test("unmapped managed files need a named opt-in and owned files require their whole item",async(t)=>{
  const {options}=await fixture(t,undefined,{"ui/manual.tsx":"export const Manual=1;"});
  const plan=await createCleanupPlan({...options,mode:"remove",targets:["ui/manual.tsx"],includeUnverified:true});
  assert.equal(plan.status,"ready",JSON.stringify(plan.diagnostics));assert.equal(plan.selected[0].kind,"file");
  await assert.rejects(createCleanupPlan({...options,mode:"remove",targets:["ui/unused.tsx"],includeUnverified:true}),{code:"PLAN_TARGET_OWNED"});
});

test("incomplete references and concurrent edits never produce an executable operation set",async(t)=>{
  const {root,options}=await fixture(t);let edited=false;
  const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true,onProgress(event){if(event.stage==="planning"&&event.state==="start"&&!edited){edited=true;writeFileSync(join(root,"src/late.tsx"),'import "../ui/unused";');}}});
  assert.equal(plan.status,"blocked");assert.equal(plan.complete,false);assert.equal(plan.operations.length,0);
  assert.ok(plan.diagnostics.some(({code})=>code==="PLAN_INPUT_ADDED"));
  writeFileSync(join(root,"src/computed.ts"),'import(process.env.COMPONENT);');
  const incomplete=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true});
  assert.equal(incomplete.status,"blocked");assert.equal(incomplete.analysis.coverage.graph,false);assert.equal(incomplete.operations.length,0);
});

test("competing origins are retained even for a named unverified request",async(t)=>{
  const {options}=await fixture(t,[item("used"),item("unused"),item("alternative",{files:[{path:"ui/unused.tsx",type:"registry:ui",content}]})]);
  const ownership=await createOwnershipSnapshot(options);
  assert.ok(ownership.excluded.some(({reasons})=>reasons.includes("OWNERSHIP_AMBIGUOUS")));
  const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true});
  assert.equal(plan.status,"blocked");assert.ok(plan.excluded[0].reasons.includes("OWNERSHIP_AMBIGUOUS"));
});

test("fresh verification descriptions never execute package scripts and required missing scripts block a plan",async(t)=>{
  const {root,options}=await fixture(t,undefined,{"package.json":JSON.stringify({dependencies:{vite:"7",react:"19"},scripts:{typecheck:`node -e "require('node:fs').writeFileSync('executed','bad')"`}})});
  const plan=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true});
  assert.equal(plan.status,"ready",JSON.stringify(plan.diagnostics));assert.equal(existsSync(join(root,"executed")),false);
  const missing=await createCleanupPlan({...options,mode:"remove",targets:["@custom/unused"],includeUnverified:true,verificationScripts:["required-check"]});
  assert.equal(missing.status,"blocked");assert.ok(missing.diagnostics.some(({code})=>code==="PLAN_VERIFICATION_MISSING"));
});

test("a recomputed artifact cannot turn a live component into an eligible deletion",async(t)=>{
  const {root,options}=await fixture(t),ownership=await createOwnershipSnapshot(options);
  const plan=await createCleanupPlan({...options,ownership,mode:"remove",targets:["@custom/unused"]});
  const used=ownership.items.find(({addresses})=>addresses.includes("@custom/used"));
  const input=plan.inputs.files.find(({path})=>path==="ui/used.tsx");
  const {id,...body}=plan;
  const forged=withId({...body,policy:{...plan.policy,targets:[used.id]},selected:[{...plan.selected[0],id:used.id,label:used.addresses[0],paths:["ui/used.tsx"]}],
    operations:[withId({kind:"delete-file",path:"ui/used.tsx",before:{sha256:input.sha256,bytes:input.bytes,mode:input.mode},after:{exists:false},owners:[used.id],diff:deletionDiff("ui/used.tsx",content)})]});
  parseCleanupPlan(forged);const checked=await checkCleanupPlan(forged,options);
  assert.equal(checked.valid,false);assert.ok(checked.diagnostics.some(({code})=>code==="PLAN_ELIGIBILITY_CHANGED"));assert.equal(readFileSync(join(root,"ui/used.tsx"),"utf8"),content);
});

for(const framework of ["next","vite-jsx"]){
  test(`cleanup plans use the shared supported analysis for ${framework}`,async(t)=>{
    const {options}=await fixture(t,undefined,(url)=>framework==="next"?{
      "package.json":'{"dependencies":{"next":"16","react":"19"}}',"src/app/(group)/page.tsx":'import {Value} from "../../../ui/used";export default function Page(){return Value;}',
    }:{"src/main.tsx":null,"ui/used.tsx":null,"ui/unused.tsx":null,"components.json":JSON.stringify({tsx:false,aliases:{ui:"./ui"},registries:{"@shadcn":`${url}/{name}.json`}}),
      "index.html":'<script type="module" src="/src/main.jsx"></script>',"src/main.jsx":'import {Value} from "../ui/used.jsx";console.log(Value);',"ui/used.jsx":content,"ui/unused.jsx":content});
    const ownership=await createOwnershipSnapshot(options),plan=await createCleanupPlan({...options,ownership});
    assert.equal(plan.status,"ready",JSON.stringify(plan.diagnostics));assert.deepEqual(plan.operations.map(({path})=>path),[framework==="next"?"ui/unused.tsx":"ui/unused.jsx"]);
  });
}

test("workspace consumers retain live components and selected package boundaries remain enforced",async(t)=>{
  const server=await registryServer(t,(req,res)=>{const name=new URL(req.url,"http://local").pathname.split("/").at(-1).replace(/\.json$/,"");const values=[item("used"),item("unused")];json(res,name==="registry"?catalog(values):values.find((value)=>value.name===name));});
  const root=createProject(t,{"package.json":'{"workspaces":["apps/*"]}',
    "apps/web/package.json":'{"dependencies":{"vite":"7","react":"19"}}',"apps/web/components.json":JSON.stringify({aliases:{ui:"./ui"},registries:{"@shadcn":`${server.url}/{name}.json`}}),
    "apps/web/index.html":'<script type="module" src="/src/main.tsx"></script>',"apps/web/src/main.tsx":'import {Value} from "../ui/used";console.log(Value);',"apps/web/ui/used.tsx":content,"apps/web/ui/unused.tsx":content,
    "apps/consumer/package.json":'{"dependencies":{"react":"19"}}',"apps/consumer/src/main.tsx":'console.log("consumer");'});
  const options={cwd:join(root,"apps/web"),cacheDir:false},ownership=await createOwnershipSnapshot(options);
  const outside=await createCleanupPlan({...options,cwd:join(root,"apps/consumer"),ownership,mode:"remove",targets:["@shadcn/unused"]});
  assert.equal(outside.status,"blocked");assert.ok(outside.excluded[0].reasons.includes("SHARED_WORKSPACE_FILE_RETAINED"));
  writeFileSync(join(root,"apps/consumer/src/main.tsx"),'import "../../web/ui/unused";');
  const shared=await createCleanupPlan({...options,ownership,mode:"remove",targets:["@shadcn/unused"]});
  assert.equal(shared.status,"blocked");assert.ok(shared.excluded[0].reasons.includes("USAGE_RETAINED"));assert.equal(shared.analysis.coverage.workspace,true);
});
