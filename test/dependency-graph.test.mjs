import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { buildDependencyGraph } from "../dist/graph/build.js";
import { graphNeighbors, GraphStore, finishGraph, nodeId } from "../dist/graph/model.js";
import { formatMermaid, selectGraph } from "../dist/graph/export.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const button = { name: "button", type: "registry:ui", dependencies: ["motion@^12"], files: [{ path: "ui/button.tsx", type: "registry:ui", content: 'import "motion/react"; export const Button = 1;' }] };

async function fixture(t, files = {}) {
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([button]) : button));
  const root = createProject(t, { "package.json": '{"dependencies":{"react":"19","motion":"^12"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json` } }),
    "ui/button.tsx": button.files[0].content,
    "src/main.tsx": 'import {Button} from "../ui/button"; export const App = () => Button;', ...files });
  return { root, server };
}

test("one graph joins registry, ownership, observed file imports and scoped package requests", async (t) => {
  const { root } = await fixture(t);
  const graph = await buildDependencyGraph({ cwd: root, cacheDir: false });
  assert.equal(graph.complete, true, JSON.stringify(graph.diagnostics));
  assert.equal(graph.graphVersion, 1);
  assert.equal(graph.coverage.usage, "not-analyzed");
  assert.equal(graph.counts.items, 1);
  assert.equal(graph.counts.localFiles, 2);
  assert.equal(graph.counts.packages, 1);
  const kinds = new Set(graph.edges.map(({ kind }) => kind));
  for (const kind of ["item-file-candidate", "file-import", "package-import", "declared-package"]) assert.ok(kinds.has(kind), kind);
  const edge = graph.edges.find(({ kind }) => kind === "file-import");
  assert.equal(edge.evidence.path, join(root, "src/main.tsx"));
  assert.equal(edge.evidence.line, 1);
  assert.ok(edge.evidence.column > 0);
});

test("snapshots remain stable across fresh network and cached metadata", async (t) => {
  const { root } = await fixture(t);
  const cache = createProject(t);
  const online = await buildDependencyGraph({ cwd: root, cacheDir: cache });
  const offline = await buildDependencyGraph({ cwd: root, cacheDir: cache, offline: true });
  assert.equal(online.snapshotId, offline.snapshotId);
  assert.deepEqual(online.counts, offline.counts);
  assert.equal(online.nodes.find(({ kind }) => kind === "item").fetch.cache, "network");
  assert.equal(offline.nodes.find(({ kind }) => kind === "item").fetch.cache, "fresh-cache");
});

test("upstream content changes update the snapshot even when graph edges stay the same", async (t) => {
  let content = "export const Button=1;";
  const server = await registryServer(t, (req, res) => {
    const value = { ...button, files: [{ ...button.files[0], content }] };
    json(res, req.url.includes("registry.json") ? catalog([value]) : value);
  });
  const root = createProject(t, { "package.json": '{"dependencies":{"motion":"^12"}}', "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json` } }), "ui/button.tsx": "export const Button=1;" });
  const first = await buildDependencyGraph({ cwd: root, cacheDir: false });
  content = "export const Button=2;";
  const second = await buildDependencyGraph({ cwd: root, cacheDir: false });
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.deepEqual(first.edges, second.edges);
});

test("request completion order cannot change which transitive items fit within a limit", async (t) => {
  let slowA = true;
  const values = [
    { ...button, name: "parent", registryDependencies: ["@shadcn/a", "@shadcn/b"], files: [] },
    { ...button, name: "a", registryDependencies: ["@shadcn/c"], files: [] },
    { ...button, name: "b", registryDependencies: ["@shadcn/d"], files: [] },
    { ...button, name: "c", files: [] }, { ...button, name: "d", files: [] },
  ];
  const server = await registryServer(t, async (req, res) => {
    if (req.url.includes("registry.json")) return json(res, catalog(values));
    const name = req.url.split("/").at(-1).replace(/\.json$/, "");
    if ((name === "a" && slowA) || (name === "b" && !slowA)) await new Promise((resolve) => setTimeout(resolve, 15));
    json(res, values.find((item) => item.name === name));
  });
  const root = createProject(t, { "package.json": '{"dependencies":{"motion":"^12"}}', "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json` } }) });
  const options = { cwd: root, cacheDir: false, scope: "catalog", items: ["parent"], maxItems: 4 };
  const first = await buildDependencyGraph(options);
  slowA = false;
  const second = await buildDependencyGraph(options);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.ok(first.nodes.some(({ label }) => label === "@shadcn/c"));
  assert.equal(first.nodes.some(({ label }) => label === "@shadcn/d"), false);
});

test("canonical snapshots ignore property insertion order, and focused views recompute cycle flags", () => {
  const input = { scope: "installed", projectRoot: "/fixture", scopes: ["/fixture"], seeds: [], sources: [], registrySources: [], diagnostics: [], coverage: { inventory: true, registry: true, source: true, usage: "not-analyzed" } };
  const first = new GraphStore();
  const second = new GraphStore();
  for (const value of ["a", "b", "c"]) {
    const id = nodeId(value);
    first.node({ id, kind: "file", label: value, scope: "/fixture", state: "present" });
    second.node({ state: "present", scope: "/fixture", label: value, kind: "file", id });
  }
  for (const store of [first, second]) {
    for (const [from, to] of [["a", "b"], ["b", "c"], ["c", "a"]]) store.edge({ from: nodeId(from), to: nodeId(to), kind: "file-import", status: "resolved", phase: "runtime" });
  }
  const graph = finishGraph(first, input);
  assert.equal(graph.snapshotId, finishGraph(second, input).snapshotId);
  const view = selectGraph(graph, "a");
  assert.equal(view.cycles.length, 0);
  assert.equal(view.edges.some(({ cycle }) => cycle), false);
});

test("unresolved package declarations cannot be reported as a complete graph", async (t) => {
  const value = { ...button, dependencies: ["git+https://example.test/package.git"] };
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([value]) : value));
  const root = createProject(t, { "package.json": "{}", "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json` } }), "ui/button.tsx": "export {};" });
  const graph = await buildDependencyGraph({ cwd: root, cacheDir: false });
  assert.equal(graph.complete, false);
  assert.ok(graph.edges.some(({ kind, status }) => kind === "declared-package" && status === "unresolved"));
});

test("focused dependent views include applications and retain the base snapshot", async (t) => {
  const { root } = await fixture(t);
  const graph = await buildDependencyGraph({ cwd: root, cacheDir: false });
  const view = selectGraph(graph, "ui/button.tsx", { direction: "dependents", transitive: true });
  assert.equal(view.view.baseSnapshotId, graph.snapshotId);
  assert.equal(view.counts.items, 1);
  assert.equal(view.counts.localFiles, 2);
  assert.equal(view.counts.packages, 0);
  assert.ok(view.nodes.some(({ path }) => path === join(root, "src/main.tsx")));
  const item = graph.nodes.find(({ kind }) => kind === "item");
  assert.ok(graphNeighbors(graph, item.id, { transitive: true }).some((id) => graph.nodes.find((node) => node.id === id).packageName === "motion"));
});

test("ambiguous focus labels expose choices without selecting a package arbitrarily", () => {
  const store = new GraphStore();
  for (const scope of ["/one", "/two"]) store.node({ id: nodeId(scope), kind: "item", label: "@custom/button", addresses: ["@custom/button"], scope, state: "present" });
  const graph = finishGraph(store, { scope: "installed", projectRoot: "/fixture", scopes: ["/one", "/two"], seeds: [], sources: [], registrySources: [], diagnostics: [], coverage: { inventory: true, registry: true, source: true, usage: "not-analyzed" } });
  assert.throws(() => selectGraph(graph, "@custom/button"), (error) => error.code === "GRAPH_NODE_AMBIGUOUS" && error.details.choices.length === 2);
  assert.throws(() => selectGraph(graph, "missing"), { code: "GRAPH_NODE_NOT_FOUND" });
});

test("Mermaid exports opaque IDs and encoded labels from the graph data", () => {
  const store = new GraphStore();
  const id = nodeId("unsafe");
  store.node({ id, kind: "item", label: 'end"]\nclick evil "javascript:alert(1)" <script>', scope: "/fixture", state: "unknown" });
  const graph = finishGraph(store, { scope: "catalog", projectRoot: "/fixture", scopes: ["/fixture"], seeds: [id], sources: [], registrySources: [], diagnostics: [], coverage: { inventory: true, registry: true, source: true, usage: "not-analyzed" } });
  const diagram = formatMermaid(graph);
  assert.match(diagram, /^flowchart LR\n%% graphVersion=1 scope=catalog complete=true snapshot=[a-f0-9]{64}/);
  assert.equal(diagram.includes("<script>"), false);
  assert.equal(diagram.includes("\nclick"), false);
  assert.match(diagram, /#34;/);
  assert.match(diagram, /^  n[a-f0-9]{64}\[".*"\]$/m);
});

test("workspace mode includes consumers without their own components config", async (t) => {
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([button]) : button));
  const root = createProject(t, {
    "package.json": '{"workspaces":["apps/*","packages/*"]}',
    "apps/web/package.json": '{"name":"web","dependencies":{"@workspace/ui":"workspace:*"}}',
    "apps/web/src/main.tsx": 'import "@workspace/ui/components/button";',
    "packages/ui/package.json": '{"name":"@workspace/ui","dependencies":{"motion":"^12"},"exports":{"./components/*":"./src/components/*.tsx"}}',
    "packages/ui/components.json": JSON.stringify({ aliases: { ui: "./src/components" }, registries: { "@shadcn": `${server.url}/{name}.json` } }),
    "packages/ui/src/components/button.tsx": button.files[0].content,
  });
  const graph = await buildDependencyGraph({ cwd: root, workspace: true, cacheDir: false });
  assert.equal(graph.complete, true, JSON.stringify(graph.diagnostics));
  assert.ok(graph.nodes.some(({ path }) => path === join(root, "apps/web/src/main.tsx")));
  assert.equal(graph.nodes.filter(({ path }) => path === join(root, "packages/ui/src/components/button.tsx")).length, 1);
});

test("API option validation fails before registry requests", async (t) => {
  const { root, server } = await fixture(t);
  for (const options of [{ scope: "unknown" }, { maxItems: 0 }, { maxFiles: 0 }, { items: ["./local"] }]) {
    await assert.rejects(buildDependencyGraph({ cwd: root, cacheDir: false, ...options }), (error) => ["INVALID_OPTIONS", "INVALID_ARGUMENT"].includes(error.code));
  }
  assert.equal(server.requests.length, 0);
});

test("available-only framework destinations do not block a selected installed graph", async (t) => {
  const unavailable = { name: "next-page", type: "registry:block", files: [{ path: "page.tsx", type: "registry:page", target: "app/server/page.tsx" }] };
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([button, unavailable]) : req.url.includes("next-page") ? unavailable : button));
  const root = createProject(t, { "package.json": '{"dependencies":{"react":"19","motion":"^12"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json` } }), "ui/button.tsx": "export {};" });
  const installed = await buildDependencyGraph({ cwd: root, cacheDir: false });
  assert.equal(installed.complete, true, JSON.stringify(installed.diagnostics));
  assert.ok(installed.diagnostics.some(({ code }) => code === "GRAPH_CATALOG_MAPPING_UNSELECTED"));
  const selected = await buildDependencyGraph({ cwd: root, cacheDir: false, scope: "catalog", items: ["next-page"] });
  assert.equal(selected.complete, false);
  assert.ok(selected.diagnostics.some(({ code }) => code === "FILE_TARGET_UNSUPPORTED"));
});
