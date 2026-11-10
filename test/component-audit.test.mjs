import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { auditProject } from "../dist/audit/build.js";
import { explainAudit } from "../dist/audit/why.js";
import { writeFileSync } from "node:fs";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const item = (name, extra = {}) => ({ name, type: "registry:ui", files: [{ path: `ui/${name}.tsx`, type: "registry:ui", content: `export const Value=1;` }], ...extra });

async function fixture(t, items = [item("used"), item("dev"), item("unused")], files = {}) {
  const server = await registryServer(t, (req, res) => {
    const name = new URL(req.url,"http://local").pathname.split("/").at(-1).replace(/\.json$/," ").trim();
    if (name === "registry") return json(res,catalog(items));
    const value = items.find((value)=>value.name===name);
    if(value)json(res,value);else{res.writeHead(404);res.end();}
  });
  const root = createProject(t, { "package.json": '{"dependencies":{"vite":"7","react":"19"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui", components: "./components", hooks: "./hooks" }, registries: { "@shadcn": `${server.url}/{name}.json`, "@custom": `${server.url}/{name}.json` } }),
    "index.html": '<script type="module" src="/src/main.tsx"></script>',
    "src/main.tsx": 'import {Value} from "../ui/used";console.log(Value);',
    "ui/used.tsx": "export const Value=1;", "ui/dev.tsx": "export const Value=1;", "ui/unused.tsx": "export const Value=1;",
    "ui/dev.stories.tsx": 'import {Value} from "./dev";console.log(Value);', ...files });
  return {root,server};
}

function byName(report,name){return report.items.find(({addresses})=>addresses.includes(`@custom/${name}`));}

test("real audit partitions runtime, development-only and unused local groups with proof", async(t)=>{
  const {root}=await fixture(t);
  const report=await auditProject({cwd:root,cacheDir:false});
  assert.equal(report.complete,true,JSON.stringify(report.diagnostics));
  assert.deepEqual([report.counts.totalItems,report.counts.runtime,report.counts.developmentOnly,report.counts.unusedCandidates,report.counts.unknown],[3,1,1,1,0]);
  assert.equal(byName(report,"used").proof.root,join(root,"src/main.tsx"));
  assert.equal(byName(report,"used").proof.path.at(-1).file,join(root,"src/main.tsx"));
  assert.equal(byName(report,"used").proof.path.at(-1).target,join(root,"ui/used.tsx"));
  assert.ok(byName(report,"unused").reasons.includes("ANALYZERS_AGREE_UNREACHABLE"));
  assert.ok(report.items.every(({cleanup})=>cleanup.eligible===false));
  assert.equal(report.counts.unknownOriginFiles,1);
  const why=explainAudit(report,"@custom/used");
  assert.equal(why.target.kind,"item");
  assert.equal(why.target.finding.usage,"runtime");
  assert.equal(why.target.files[0].consumers[0].line,1);
});

test("unknown references retain unused files without erasing known runtime evidence",async(t)=>{
  const {root}=await fixture(t,undefined,{"src/dynamic.ts":"import(process.env.COMPONENT);"});
  const report=await auditProject({cwd:root,cacheDir:false});
  assert.equal(report.complete,false);
  assert.equal(report.counts.unusedCandidates,0);
  assert.equal(byName(report,"unused").usage,"unknown");
  assert.equal(byName(report,"used").usage,"runtime");
  assert.ok(byName(report,"unused").retention.includes("ANALYSIS_INCOMPLETE"));
});

test("partial items and shared effects stay unknown when their source files are unused",async(t)=>{
  const values=[item("used"),item("partial",{files:[{path:"ui/partial.tsx",type:"registry:ui"},{path:"use-partial.ts",type:"registry:hook"}]}),item("effect",{cssVars:{light:{brand:"red"}}})];
  const {root}=await fixture(t,values,{"ui/partial.tsx":"export const Value=1;","ui/effect.tsx":"export const Value=1;"});
  const report=await auditProject({cwd:root,cacheDir:false});
  assert.equal(report.complete,true,JSON.stringify(report.diagnostics));
  assert.equal(byName(report,"partial").usage,"unknown");
  assert.ok(byName(report,"partial").retention.includes("PARTIAL_ITEM"));
  assert.equal(byName(report,"effect").usage,"unknown");
  assert.ok(byName(report,"effect").retention.includes("SHARED_RESOURCE_RETAINED"));
});

test("registry declarations explain retention without pretending they are observed imports",async(t)=>{
  const {root}=await fixture(t,[item("used",{registryDependencies:["@custom/unused"]}),item("unused")]);
  const report=await auditProject({cwd:root,cacheDir:false});
  assert.equal(byName(report,"unused").usage,"unused-candidate");
  assert.ok(byName(report,"unused").retention.includes("REGISTRY_DEPENDENT_RETAINED"));
  assert.equal(byName(report,"unused").declaredDependents[0].usage,"runtime");
});

test("Knip/reference disagreement is retained and can be resolved with explicit dev entries",async(t)=>{
  const {root}=await fixture(t,undefined,{"package.json":'{"scripts":{"test":"node ui/unused.tsx"},"dependencies":{"vite":"7","react":"19"}}'});
  const uncertain=await auditProject({cwd:root,cacheDir:false});
  assert.equal(uncertain.complete,false);
  assert.equal(byName(uncertain,"unused").usage,"unknown");
  assert.ok(uncertain.diagnostics.some(({code})=>code==="ANALYZER_DISAGREEMENT"));
  const explicit=await auditProject({cwd:root,cacheDir:false,devEntries:["ui/unused.tsx"]});
  assert.equal(byName(explicit,"unused").usage,"development-only",JSON.stringify(explicit.diagnostics));
});

test("public workspace contracts are retained and all consumers are inspected by default",async(t)=>{
  const server=await registryServer(t,(req,res)=>json(res,req.url.includes("registry.json")?catalog([item("public")]):item("public")));
  const root=createProject(t,{"package.json":'{"workspaces":["apps/*","packages/*"]}',
    "apps/web/package.json":'{"name":"web","dependencies":{"react":"19","vite":"7"}}',"apps/web/index.html":'<script type="module" src="/src/main.tsx"></script>',"apps/web/src/main.tsx":"export const App=1;",
    "packages/ui/package.json":'{"name":"@workspace/ui","exports":{"./ui/*":"./ui/*.tsx"}}',
    "packages/ui/components.json":JSON.stringify({aliases:{ui:"./ui"},registries:{"@shadcn":`${server.url}/{name}.json`}}),"packages/ui/ui/public.tsx":"export const Value=1;"});
  const report=await auditProject({cwd:join(root,"apps/web"),cacheDir:false});
  assert.equal(report.complete,true,JSON.stringify(report.diagnostics));
  assert.equal(report.coverage.workspace,true);
  assert.equal(report.items[0].usage,"unknown");
  assert.ok(report.items[0].retention.includes("PUBLIC_API_RETAINED"));
  assert.ok(report.scopes.includes(join(root,"apps/web")));
  const restricted=await auditProject({cwd:join(root,"apps/web"),cacheDir:false,workspace:false});
  assert.equal(restricted.complete,false);
  assert.equal(restricted.coverage.workspace,false);
  assert.equal(restricted.counts.unusedCandidates,0);
});

test("snapshot IDs ignore analysis timings and why rejects missing findings",async(t)=>{
  const {root}=await fixture(t);
  const cache=createProject(t);
  const first=await auditProject({cwd:root,cacheDir:cache});
  const second=await auditProject({cwd:root,cacheDir:cache,offline:true});
  assert.equal(first.snapshotId,second.snapshotId);
  assert.equal(explainAudit(first,"ui/used.tsx").target.kind,"file");
  assert.throws(()=>explainAudit(first,"not-installed"),{code:"WHY_NOT_FOUND"});
});

test("related packages are candidates only when no runtime, development, or retained consumer requires them",async(t)=>{
  const values=[item("used",{dependencies:["live-pkg"]}),item("dev",{dependencies:["dev-pkg"]}),item("unused",{dependencies:["orphan-pkg","script-pkg","react"]})];
  const {root}=await fixture(t,values,{
    "package.json":JSON.stringify({scripts:{check:"script-pkg --check"},dependencies:{vite:"7",react:"19","live-pkg":"1","dev-pkg":"1","orphan-pkg":"1","script-pkg":"1"}}),
    "ui/used.tsx":'import "live-pkg";export const Value=1;',
    "ui/dev.tsx":'import "dev-pkg";export const Value=1;',
    "ui/unused.tsx":'import "orphan-pkg";export const Value=1;',
  });
  const report=await auditProject({cwd:root,cacheDir:false});
  assert.equal(report.complete,true,JSON.stringify(report.diagnostics));
  const get=(name)=>report.packages.find((pkg)=>pkg.name===name);
  assert.equal(get("live-pkg").status,"runtime");
  assert.equal(get("dev-pkg").status,"development-only");
  assert.equal(get("orphan-pkg").status,"candidate");
  assert.equal(get("script-pkg").status,"retain");
  assert.ok(get("script-pkg").reasons.includes("SCRIPT_PACKAGE_REQUIREMENT"));
  assert.ok(get("react").reasons.includes("FRAMEWORK_PACKAGE_RETAINED"));
  assert.equal(explainAudit(report,"orphan-pkg").target.kind,"package");
  assert.ok(report.packages.every(({cleanup})=>cleanup.eligible===false));
  writeFileSync(join(root,"src/main.tsx"),'import {Value} from "../ui/used";import "orphan-pkg";console.log(Value);');
  const shared=await auditProject({cwd:root,cacheDir:false});
  assert.equal(shared.packages.find(({name})=>name==="orphan-pkg").status,"runtime");
});

test("type-only paths stay development-only and literal lazy runtime imports retain components",async(t)=>{
  const {root}=await fixture(t,undefined,{
    "src/main.tsx":'import type {Value} from "../ui/dev";export type T=Value;import("../ui/used");',
    "ui/dev.tsx":"export interface Value {x:number}",
    "ui/dev.stories.tsx":"export {};",
  });
  const report=await auditProject({cwd:root,cacheDir:false});
  assert.equal(report.complete,true,JSON.stringify(report.diagnostics));
  assert.equal(byName(report,"used").usage,"runtime");
  assert.equal(byName(report,"dev").usage,"development-only");
  assert.equal(byName(report,"dev").proof.typeOnly,true);
  assert.ok(byName(report,"dev").reasons.includes("TYPE_ONLY_REFERENCE"));
});

test("competing origins share physical-file groups and why requires unambiguous references",async(t)=>{
  const values=[item("used"),item("alternate",{files:[{path:"ui/used.tsx",type:"registry:ui"}]}),item("unused",{dependencies:["unused"]})];
  const {root}=await fixture(t,values,{"package.json":'{"dependencies":{"vite":"7","react":"19","unused":"1"}}'});
  const report=await auditProject({cwd:root,cacheDir:false});
  const used=byName(report,"used");
  assert.equal(used.id,byName(report,"alternate").id);
  assert.ok(used.retention.includes("OWNERSHIP_AMBIGUOUS"));
  assert.throws(()=>explainAudit(report,"unused"),{code:"WHY_AMBIGUOUS"});
  assert.equal(explainAudit(report,"@custom/unused").target.kind,"item");
});

test("analysis cancellation never produces unused candidates",async(t)=>{
  const {root}=await fixture(t);
  const report=await auditProject({cwd:root,cacheDir:false,signal:AbortSignal.abort()});
  assert.equal(report.complete,false);
  assert.equal(report.counts.unusedCandidates,0);
  assert.throws(()=>explainAudit(report,"absent"),{code:"WHY_UNRESOLVED"});
});
