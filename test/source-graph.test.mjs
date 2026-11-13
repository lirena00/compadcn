import assert from "node:assert/strict";
import { join } from "node:path";
import { symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { parseReferences } from "../dist/graph/references.js";
import { sourceGraph } from "../dist/graph/source.js";
import { GraphStore, fileId, finishGraph } from "../dist/graph/model.js";
import { discoverProject } from "../dist/project/discover.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

function project(t, files = {}) {
  return createProject(t, { "package.json": '{"dependencies":{"react":"19","motion":"^12"}}', "components.json": '{"aliases":{"ui":"./src/components/ui"}}',
    "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]},"moduleResolution":"bundler"}}', ...files });
}

function build(root, options = {}) {
  const context = discoverProject({ cwd: root, env: {} });
  const store = new GraphStore();
  const result = sourceGraph(store, context, options.roots ?? [root], { maxFiles: 20000, ...options });
  return finishGraph(store, { scope: "installed", projectRoot: root, scopes: result.scopes, seeds: [], sources: [], registrySources: [], diagnostics: result.diagnostics,
    coverage: { inventory: true, registry: true, source: result.complete, usage: "not-analyzed" } });
}

test("Next generated route declarations are retained and hashed; local references keep ordinary safeguards", (t) => {
  const root = project(t, { "package.json": '{"dependencies":{"next":"16"}}', "app/page.tsx": "export default function Page() {return null;}",
    "next-env.d.ts": 'import "./.next/types/routes.d.ts";', ".next/types/package.json": '{"type":"module"}', ".next/types/routes.d.ts": 'export type Routes = "/";' });
  const first = build(root);
  assert.equal(first.complete, true, JSON.stringify(first.diagnostics));
  const resource = first.nodes.find(node => node.resourceKind === "next-generated-types");
  assert.equal(resource?.retained, true);
  assert.deepEqual(first.scopes, [root]);
  writeFileSync(join(root, ".next/types/routes.d.ts"), 'export type Routes = "/changed";');
  assert.notEqual(build(root).snapshotId, first.snapshotId);
  writeFileSync(join(root, ".next/types/routes.d.ts"), 'import "../../app/page";');
  const custom = build(root);
  assert.equal(custom.nodes.some(node => node.resourceKind === "next-generated-types"), false);
  assert.ok(custom.nodes.some(node => node.path === join(root, ".next/types/routes.d.ts") && node.kind === "file"));
  writeFileSync(join(root, ".next/types/routes.d.ts"), '/// <reference path="../../app/page.tsx" />\nexport {};');
  assert.equal(build(root).nodes.some(node => node.resourceKind === "next-generated-types"), false);
});

test("AST references distinguish import forms, type phases and source locations", () => {
  const parsed = parseReferences("fixture.tsx", [
    'import Default, { Named } from "./default";',
    'import type { Type } from "./types";',
    'import { type Other } from "./other";',
    'import * as All from "./namespace";',
    'import "./effect";',
    'export { Named } from "./export";',
    'export type { Other } from "./export-type";',
    'export * from "./barrel";',
    'const dynamic = import("./lazy");',
    'const required = require("./required");',
    'const path = require.resolve("./resolve");',
    'type Inline = import("./inline").Type;',
    'import Legacy = require("./legacy");',
    '// import "./comment";',
    'const text = "import fake from fake";',
  ].join("\n"));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.references.length, 13);
  assert.equal(parsed.references[0].line, 1);
  assert.ok(parsed.references.filter(({ specifier }) => ["./types", "./other", "./export-type", "./inline"].includes(specifier)).every(({ phase }) => phase === "type"));
  assert.ok(parsed.references.some(({ syntax }) => syntax === "import-equals"));
  assert.equal(parsed.references.some(({ specifier }) => specifier === "./comment"), false);
});

test("comments cannot invent edges, while literal dynamic and CommonJS imports resolve", (t) => {
  const root = project(t, { "src/main.ts": '// import "./missing"\nconst a=import(`./lazy`);const b=require("./common");', "src/lazy.ts": "export {};", "src/common.js": "module.exports={};" });
  const result = build(root);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.equal(result.edges.length, 2);
});

test("aliases, extension substitutions, directory indexes and barrels resolve actual files", (t) => {
  const root = project(t, { "src/main.tsx": 'import {Button} from "@/components/ui"; import "./helper.js";', "src/components/ui/index.ts": 'export {Button} from "./button";',
    "src/components/ui/button.tsx": "export const Button=()=>null;", "src/helper.ts": "export {};" });
  const result = build(root);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.ok(result.edges.some(({ from, to }) => from === fileId(join(root, "src/main.tsx")) && to === fileId(join(root, "src/helper.ts"))));
  assert.equal(result.edges.filter(({ kind }) => kind === "file-import").length, 3);
});

test("Vite references use the compiler mapping applicable to each source file", (t) => {
  const root = project(t, {
    "tsconfig.json": '{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}',
    "tsconfig.app.json": '{"include":["src"],"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    "tsconfig.node.json": '{"include":["vite.config.ts"],"compilerOptions":{"paths":{"@/*":["./tools/*"]}}}',
    "src/main.tsx": 'import "@/ui";', "src/ui.ts": "export {};", "tools/ui.ts": "export {};", "vite.config.ts": 'import "@/ui";',
  });
  const result = build(root);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.ok(result.edges.some(({ from, to }) => from === fileId(join(root, "vite.config.ts")) && to === fileId(join(root, "tools/ui.ts"))));
  assert.ok(result.edges.some(({ from, to }) => from === fileId(join(root, "src/main.tsx")) && to === fileId(join(root, "src/ui.ts"))));
});

test("package imports and unlinked shared workspace exports resolve source files", (t) => {
  const root = createProject(t, { "package.json": '{"workspaces":["apps/*","packages/*"]}',
    "apps/web/package.json": '{"name":"web","dependencies":{"react":"19","@workspace/ui":"workspace:*"},"imports":{"#components/*":"./src/components/*.tsx"}}',
    "apps/web/components.json": '{"aliases":{"ui":"@workspace/ui/components"}}',
    "apps/web/src/main.tsx": 'import "#components/local"; import "@workspace/ui/components/button";', "apps/web/src/components/local.tsx": "export {};",
    "packages/ui/package.json": '{"name":"@workspace/ui","peerDependencies":{"react":"19"},"exports":{"./components/*":"./src/components/*.tsx"}}',
    "packages/ui/src/components/button.tsx": 'import type {ReactNode} from "react";',
  });
  const result = build(join(root, "apps/web"));
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  const shared = result.nodes.find(({ path }) => path === join(root, "packages/ui/src/components/button.tsx"));
  assert.equal(shared.scope, join(root, "packages/ui"));
  assert.ok(result.edges.some(({ from, kind, phase }) => from === shared.id && kind === "package-import" && phase === "type"));
});

test("observed npm use and built-ins have distinct relations and declared specs", (t) => {
  const root = project(t, { "src/main.ts": 'import "motion/react"; import "node:fs"; import "fs/promises";' });
  const result = build(root);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.equal(result.counts.packages, 1);
  assert.equal(result.nodes.find(({ packageName }) => packageName === "motion").manifestSpec, "^12");
  assert.equal(result.edges.filter(({ kind }) => kind === "builtin-import").length, 2);
});

for (const [label, code, source] of [
  ["computed import", "SOURCE_COMPUTED_REFERENCE", "const name='./ui'; import(name);"],
  ["computed require", "SOURCE_COMPUTED_REFERENCE", "require(process.env.MODULE);"],
  ["glob import", "SOURCE_COMPUTED_REFERENCE", 'import.meta.glob("./ui/*.tsx");'],
  ["missing alias", "SOURCE_IMPORT_UNRESOLVED", 'import "@/missing";'],
  ["missing relative file", "SOURCE_IMPORT_UNRESOLVED", 'import "./missing";'],
  ["undeclared package", "SOURCE_PACKAGE_UNRESOLVED", 'import "unknown-package";'],
  ["remote module", "SOURCE_ADDRESS_UNSUPPORTED", 'import "https://example.test/module.js?token=private-token";'],
  ["syntax error", "SOURCE_PARSE_FAILED", "export const = ;"],
]) {
  test(`${label} preserves incomplete source coverage`, (t) => {
    const root = project(t, { "src/main.ts": source });
    const result = build(root);
    assert.equal(result.complete, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), JSON.stringify(result.diagnostics));
    assert.equal(JSON.stringify(result).includes("private-token"), false);
  });
}

test("source cycles are recorded independently from registry cycles", (t) => {
  const root = project(t, { "src/a.ts": 'export * from "./b";', "src/b.ts": 'export * from "./a";' });
  const result = build(root);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].kind, "source");
  assert.equal(result.cycles[0].nodes.length, 2);
});

test("a locally shadowed require cannot create a fabricated module edge", (t) => {
  const root = project(t, { "src/main.ts": 'function load(require: (name:string)=>unknown) { return require("./fabricated"); }' });
  const result = build(root);
  assert.equal(result.complete, false);
  assert.ok(result.diagnostics.some(({ code }) => code === "SOURCE_SHADOWED_REQUIRE"));
  assert.equal(result.nodes.some(({ path }) => path?.includes("fabricated")), false);
});

test("file limits, unsupported formats and scope escapes cannot produce a clean graph", (t) => {
  const root = project(t, { "src/a.ts": "export {};", "src/b.ts": "export {};", "src/content.mdx": "# content" });
  assert.ok(build(root, { maxFiles: 1 }).diagnostics.some(({ code }) => code === "GRAPH_FILE_LIMIT"));
  assert.ok(build(root).diagnostics.some(({ code }) => code === "SOURCE_FORMAT_UNSUPPORTED"));
  const outside = createProject(t, { "outside.ts": "export {};" });
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const escaped = project(t, { "src/main.ts": 'import "@/outside";', "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": [`${outside.replaceAll("\\", "/")}/*`] } } }) });
  assert.ok(build(escaped).diagnostics.some(({ code }) => code === "SOURCE_TARGET_OUTSIDE_SCOPE"));
});

test("non-code imported files are retained resources and never parsed as JavaScript", (t) => {
  const root = project(t, { "src/main.ts": 'import "./global.css";', "src/global.css": ".button { color:red; }" });
  const result = build(root);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.equal(result.nodes.find(({ path }) => path?.endsWith("global.css")).retained, true);
});
