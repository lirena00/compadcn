import assert from "node:assert/strict";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { takeScopeSnapshot, snapshotChanges } from "../dist/changes/snapshot.js";
import { parseOwnershipSnapshot, withId } from "../dist/changes/schema.js";
import { deletionDiff, validateDeletionDiff } from "../dist/changes/diff.js";
import { digest } from "../dist/core/hash.js";
import { packageInfo } from "../dist/lib/packageInfo.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

test("scope snapshots fingerprint consumers, metadata and lockfiles while excluding generated state",async(t)=>{
  const root=createProject(t,{"package.json":'{"registries":{"@private":"private-config-secret"}}',"src/main.tsx":"export {};","pnpm-lock.yaml":"lockfileVersion: 9",".shadcn-plus/plans/old.json":"{}","node_modules/ignored.js":"1"});
  const first=await takeScopeSnapshot(root),second=await takeScopeSnapshot(root);
  assert.equal(first.complete,true,JSON.stringify(first.diagnostics));assert.equal(first.fingerprint,second.fingerprint);
  assert.deepEqual(first.files.map(({path})=>path),["package.json","pnpm-lock.yaml","src/main.tsx"]);
  assert.doesNotMatch(JSON.stringify(first),/private-config-secret/);
  writeFileSync(join(root,"src/new-consumer.tsx"),'import "./main";');
  const changed=await takeScopeSnapshot(root);
  assert.ok(snapshotChanges(first,changed).some(({code,path})=>code==="PLAN_INPUT_ADDED"&&path==="src/new-consumer.tsx"));
  writeFileSync(join(root,"package.json"),'{}');
  assert.ok(snapshotChanges(changed,await takeScopeSnapshot(root)).some(({code,path})=>code==="PLAN_INPUT_CHANGED"&&path==="package.json"));
});

test("snapshot limits, cancellation and linked directories preserve incomplete coverage",async(t)=>{
  const root=createProject(t,{"package.json":"{}","source.ts":"export const X=1;"});
  assert.equal((await takeScopeSnapshot(root,{maxInputFiles:1})).complete,false);
  assert.equal((await takeScopeSnapshot(root,{maxInputBytes:2})).complete,false);
  assert.equal((await takeScopeSnapshot(root,{signal:AbortSignal.abort()})).complete,false);
  const outside=createProject(t,{"secret.ts":"do-not-read-target"});
  try{symlinkSync(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");}catch(error){if(error.code==="EPERM")return;throw error;}
  const linked=await takeScopeSnapshot(root);
  assert.equal(linked.complete,false);assert.ok(linked.diagnostics.some(({code})=>code==="PLAN_LINK_UNSUPPORTED"));
  assert.ok(linked.files.some(({kind,path})=>kind==="link"&&path==="linked"));
  assert.doesNotMatch(JSON.stringify(linked),/do-not-read-target|secret.ts/);
});

test("ownership artifacts use strict versioned schemas and detect changed content",()=>{
  const artifact=withId({ownershipVersion:1,toolVersion:packageInfo.version,project:{root:process.cwd(),selected:".",scopes:["."]},baseline:"observed-local-files",items:[],excluded:[],diagnostics:[],complete:true});
  assert.equal(parseOwnershipSnapshot(JSON.stringify(artifact)).id,artifact.id);
  assert.throws(()=>parseOwnershipSnapshot({...artifact,complete:false}),{code:"OWNERSHIP_TAMPERED"});
  assert.throws(()=>parseOwnershipSnapshot({...artifact,unexpected:true}),{code:"OWNERSHIP_INVALID"});
  assert.throws(()=>parseOwnershipSnapshot({...artifact,ownershipVersion:2}),{code:"OWNERSHIP_INVALID"});
});

for(const source of ["export const X=1;\n","line one\r\nline two\r\n","no final newline","","\uFEFFexport {};\n"]){
  test(`deletion previews preserve exact bytes (${JSON.stringify(source)})`,()=>{
    const path="src/with spaces/[name].tsx",patch=deletionDiff(path,source);
    validateDeletionDiff(path,patch,digest(source),Buffer.byteLength(source));
    assert.throws(()=>validateDeletionDiff("different.ts",patch,digest(source),Buffer.byteLength(source)),{code:"PLAN_PREVIEW_INVALID"});
  });
}
