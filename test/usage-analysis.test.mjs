import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { discoverProject } from "../dist/project/discover.js";
import { GraphStore, fileId, finishGraph } from "../dist/graph/model.js";
import { discoverRoots } from "../dist/analysis/roots.js";
import { analyzeWithKnip, parseKnipReport } from "../dist/analysis/knip.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

function project(t, extra = {}) {
  return createProject(t, { "package.json": '{"dependencies":{"vite":"7","react":"19"}}', "components.json": '{"aliases":{"ui":"./src/ui"}}',
    "index.html": '<script type="module" src="/src/main.tsx"></script>',
    "src/main.tsx": 'import {Used} from "./ui/used";console.log(Used);',
    "src/ui/used.tsx": "export const Used=1;", "src/ui/unused.tsx": "export const Unused=1;",
    "src/ui/dev.tsx": "export const Dev=1;", "src/ui/dev.test.tsx": 'import {Dev} from "./dev";console.log(Dev);', ...extra });
}

function policy(root, options) {
  const store = new GraphStore();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    store.node({ id: fileId(path), kind: "file", label: path, path, scope: root, state: "present" });
  }
  const graph = finishGraph(store, { scope: "installed", projectRoot: root, scopes: [root], seeds: [], sources: [], registrySources: [], diagnostics: [], coverage: { inventory: true, registry: true, source: true, usage: "not-analyzed" } });
  return discoverRoots(graph, discoverProject({ cwd: root }), options);
}

test("real pinned Knip separates all-source and production unused files", async (t) => {
  const root = project(t);
  const roots = policy(root);
  assert.equal(roots.complete, true, JSON.stringify(roots.diagnostics));
  const result = await analyzeWithKnip(roots);
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.version, "6.45.0");
  assert.ok(result.all.unusedFiles.includes(join(root, "src/ui/unused.tsx")));
  assert.equal(result.all.unusedFiles.includes(join(root, "src/ui/used.tsx")), false);
  assert.equal(result.all.unusedFiles.includes(join(root, "src/ui/dev.tsx")), false);
  assert.ok(result.production.unusedFiles.includes(join(root, "src/ui/dev.tsx")));
  assert.ok(result.production.durationMs > 0);
});

test("framework and Knip project configs are not executed, including script config arguments", async (t) => {
  const root = project(t, {
    "package.json": '{"scripts":{"dev":"vite --config vite.config.js"},"dependencies":{"vite":"7","react":"19"}}',
    "vite.config.js": 'import fs from "node:fs";fs.writeFileSync("framework-executed","bad");export default {};',
    "knip.config.js": 'import fs from "node:fs";fs.writeFileSync("knip-executed","bad");export default {};',
  });
  const before = Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => { const path=join(entry.parentPath,entry.name);return[relative(root,path),readFileSync(path,"base64")]; }));
  const result = await analyzeWithKnip(policy(root));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(existsSync(join(root, "framework-executed")), false);
  assert.equal(existsSync(join(root, "knip-executed")), false);
  for (const [name, value] of Object.entries(before)) assert.equal(readFileSync(join(root, name), "base64"), value);
});

test("Next app/pages roots, development roots, and public exports are distinct", (t) => {
  const root = project(t, {
    "package.json": '{"dependencies":{"next":"16","react":"19"},"exports":{"./public/*":"./src/public/*.tsx"}}',
    "src/app/(group)/page.tsx": "export default function Page(){return null;}", "pages/other.tsx": "export default 1;",
    "src/public/button.tsx": "export const Public=1;", "next.config.ts": 'const nextConfig={reactStrictMode:true};export default nextConfig;',
  });
  const roots = policy(root);
  assert.equal(roots.complete, true, JSON.stringify(roots.diagnostics));
  assert.ok(roots.roots.some(({ path, role }) => path.endsWith("page.tsx") && role === "runtime"));
  assert.ok(roots.roots.some(({ path, role }) => path.endsWith("other.tsx") && role === "runtime"));
  assert.ok(roots.roots.some(({ path, role }) => path.endsWith("button.tsx") && role === "public"));
  assert.ok(roots.roots.some(({ path, role }) => path.endsWith("next.config.ts") && role === "development"));
});

test("HTML comments/templates cannot fabricate roots and inline imports are parsed", (t) => {
  const root = project(t, { "index.html": '<!-- <script type="module" src="/src/ui/unused.tsx"></script> --><template><script type="module" src="/src/ui/unused.tsx"></script></template><script type="module">import "./src/main.tsx";</script>' });
  const roots = policy(root);
  assert.equal(roots.complete, true, JSON.stringify(roots.diagnostics));
  assert.deepEqual(roots.roots.filter(({ role }) => role === "runtime").map(({ path }) => path), [join(root, "src/main.tsx")]);
});

test("dynamic framework entry settings require an explicit policy rather than execution", (t) => {
  const root = project(t, { "vite.config.ts": 'export default {build:{rollupOptions:{input:"custom.html"}}};' });
  assert.ok(policy(root).diagnostics.some(({ code }) => code === "FRAMEWORK_ENTRY_POLICY_REQUIRED"));
  assert.equal(policy(root, { entries: ["src/main.tsx"] }).complete, true);
  assert.equal(policy(root, { entries: ["missing.tsx"] }).complete, false);
});

test("unresolved native imports, malformed reports, and timeouts stay incomplete", async (t) => {
  const root = project(t, { "src/main.tsx": 'import "./does-not-exist";' });
  const roots = policy(root);
  const result = await analyzeWithKnip(roots);
  assert.equal(result.complete, false);
  assert.ok(result.all.diagnostics.some(({ code }) => code === "KNIP_UNRESOLVED"));
  assert.throws(() => parseKnipReport('{"files":[]}', roots, "all"), { code: "KNIP_REPORT_INVALID" });
  assert.throws(() => parseKnipReport('{"issues":[{"file":"../outside.ts","files":[{}],"unresolved":[]}]}', roots, "all"), { code: "KNIP_REPORT_OUTSIDE_SCOPE" });
  const timeout = await analyzeWithKnip(roots, { analysisTimeoutMs: 1 });
  assert.equal(timeout.complete, false);
  assert.ok(timeout.all.diagnostics.some(({ code }) => code === "ANALYSIS_TIMEOUT"));
  const cancelled = await analyzeWithKnip(roots, { signal: AbortSignal.abort() });
  assert.ok(cancelled.all.diagnostics.some(({ code }) => code === "ANALYSIS_CANCELLED"));
});
