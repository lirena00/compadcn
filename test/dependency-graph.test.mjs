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
