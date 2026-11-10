import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createInventorySession } from "../dist/inventory/build.js";
import { registryClosure } from "../dist/graph/registry.js";
import { finishGraph, GraphStore, graphNeighbors, nodeId } from "../dist/graph/model.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const file = (name) => ({ path: `ui/${name}.tsx`, type: "registry:ui", content: "export {};" });
const item = (name, dependencies = [], extra = {}) => ({ name, type: "registry:ui", files: [file(name)], registryDependencies: dependencies, ...extra });

async function fixture(t, official, custom, extra = {}) {
  const server = await registryServer(t, (req, res) => {
    const url = new URL(req.url, "http://local");
    const values = url.pathname.startsWith("/official/") ? official : custom;
    if (url.pathname.endsWith("/registry.json")) return json(res, catalog(values));
    const name = url.pathname.split("/").at(-1).replace(/\.json$/, "");
    const result = values.find((value) => value.name === name);
    if (result) json(res, result); else { res.writeHead(404); res.end(); }
  });
  const root = createProject(t, {
    "package.json": '{"dependencies":{"react":"19","vite":"7"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/official/{name}.json`, "@custom": `${server.url}/custom/{name}.json` } }),
    "ui/parent.tsx": "export {};", ...extra,
  });
  return { root, server };
}

async function graph(root, options = {}) {
  const session = await createInventorySession({ cwd: root, cacheDir: false, ...options, items: options.items?.filter((value) => value.startsWith("@")) });
  const store = new GraphStore();
  const closure = await registryClosure(session, store, { scope: "installed", maxItems: 2000, concurrency: 4, ...options });
  return finishGraph(store, { scope: options.scope ?? "installed", projectRoot: root, scopes: session.report.scopes,
    seeds: closure.seeds, sources: session.report.sources, registrySources: closure.sources.map(({ descriptor }) => descriptor),
    diagnostics: closure.diagnostics, coverage: { inventory: session.report.complete, registry: closure.complete, source: true, usage: "not-analyzed" } });
}

test("bare dependencies resolve to official items and cross-registry identities remain distinct", async (t) => {
  const { root, server } = await fixture(t, [item("button")], [item("parent", ["button", "@custom/button"]), item("button")]);
  const result = await graph(root);
  assert.equal(result.counts.items, 3);
  assert.equal(result.seeds.length, 1);
  const parent = result.nodes.find(({ label }) => label === "@custom/parent");
  const dependencies = graphNeighbors(result, parent.id, { kinds: ["registry-dependency"] });
  assert.deepEqual(dependencies.map((id) => result.nodes.find((node) => node.id === id).label).sort(), ["@custom/button", "@shadcn/button"]);
  assert.equal(result.nodes.find(({ label }) => label === "@shadcn/button").state, "absent");
  assert.equal(server.requests.filter(({ path }) => path === "/official/button.json").length, 1);
});

test("registry cycles and reverse/transitive dependents are explicit without repeated fetches", async (t) => {
  const { root, server } = await fixture(t, [], [item("parent", ["@custom/child"]), item("child", ["@custom/parent"])]);
  const result = await graph(root);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].kind, "registry");
  assert.equal(result.cycles[0].edges.length, 2);
  assert.ok(result.edges.filter(({ kind }) => kind === "registry-dependency").every(({ cycle }) => cycle));
  const child = result.nodes.find(({ label }) => label === "@custom/child");
  assert.equal(graphNeighbors(result, child.id, { direction: "dependents", transitive: true, kinds: ["registry-dependency"] }).length, 1);
  assert.equal(server.requests.filter(({ path }) => path.endsWith("/parent.json")).length, 1);
});

test("missing namespaces, failed manifests and unsupported addresses retain unresolved edges", async (t) => {
  const { root } = await fixture(t, [], [item("parent", ["@missing/child", "@custom/missing", "owner/repository/item"])]);
  const result = await graph(root);
  assert.equal(result.complete, false);
  assert.equal(result.counts.unresolved, 3);
  assert.equal(result.edges.filter(({ kind, status }) => kind === "registry-dependency" && status === "unresolved").length, 3);
});

test("catalog graph requests transitive manifests while installed scope excludes catalog-only seeds", async (t) => {
  const { root } = await fixture(t, [], [item("parent"), item("available", ["@custom/child"]), item("child")]);
  assert.equal((await graph(root)).counts.items, 1);
  const available = await graph(root, { scope: "catalog", items: ["@custom/available"] });
  assert.equal(available.counts.items, 2);
  assert.equal(available.seeds.length, 1);
  assert.ok(available.nodes.filter(({ kind }) => kind === "item").every(({ state }) => state === "absent"));
  assert.ok((await graph(root, { items: ["@custom/available"] })).diagnostics.some(({ code }) => code === "GRAPH_ITEM_NOT_LOCAL"));
});

test("shared effects and requested npm specifications remain separate from installed resolution", async (t) => {
  const { root } = await fixture(t, [], [item("parent", [], { dependencies: ["motion@^12", "@scope/pkg@1"], devDependencies: ["vitest"], cssVars: { light: { brand: "red" } }, envVars: { SECRET: "never-print-this" } })]);
  const result = await graph(root);
  assert.equal(result.counts.packages, 3);
  assert.equal(result.counts.resources, 2);
  assert.ok(result.nodes.filter(({ kind }) => kind === "resource").every(({ retained }) => retained));
  assert.ok(result.edges.some(({ kind, evidence }) => kind === "declared-package" && evidence.specification === "motion@^12"));
  assert.equal(JSON.stringify(result).includes("never-print-this"), false);
});

test("direct authenticated URLs never receive the parent registry's authorization", async (t) => {
  const remote = await registryServer(t, (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(new URL(req.url, "http://local").searchParams.get("token"), "private-token");
    json(res, item("remote"));
  });
  const parent = item("parent", [`${remote.url}/remote.json?token=private-token`]);
  const { root } = await fixture(t, [], [parent]);
  const cache = createProject(t);
  const first = await graph(root, { cacheDir: cache });
  assert.equal(first.counts.items, 2);
  assert.equal(first.complete, true);
  assert.equal(JSON.stringify(first).includes("private-token"), false);
  const cachedText = readdirSync(cache).filter((file) => file.endsWith(".json")).map((file) => readFileSync(join(cache, file), "utf8")).join("");
  assert.equal(cachedText.includes("private-token"), false);
  const offline = await graph(root, { cacheDir: cache, offline: true });
  assert.equal(offline.complete, false);
  assert.ok(offline.diagnostics.some(({ code }) => code === "REGISTRY_REFERENCE_UNAVAILABLE"));
  const recovered = await graph(root, { cacheDir: cache });
  assert.equal(recovered.complete, true);
  assert.equal(recovered.counts.items, 2);
});

test("closure limits retain a bounded graph and a diagnostic", async (t) => {
  const { root } = await fixture(t, [], [item("parent", ["@custom/a"]), item("a", ["@custom/b"]), item("b")]);
  const result = await graph(root, { maxItems: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.counts.items, 1);
  assert.ok(result.diagnostics.some(({ code }) => code === "GRAPH_ITEM_LIMIT"));
});

test("cycle detection handles long chains and isolated self-loops iteratively", () => {
  const store = new GraphStore();
  for (let index = 0; index < 12000; index++) {
    const id = nodeId(String(index));
    store.node({ id, kind: "file", label: String(index), scope: "/fixture", state: "present" });
    if (index) store.edge({ from: nodeId(String(index - 1)), to: id, kind: "file-import", status: "resolved", phase: "runtime" });
  }
  store.edge({ from: nodeId("11999"), to: nodeId("11999"), kind: "file-import", status: "resolved", phase: "runtime" });
  const result = finishGraph(store, { scope: "installed", projectRoot: "/fixture", scopes: ["/fixture"], seeds: [], sources: [], registrySources: [], diagnostics: [], coverage: { inventory: true, registry: true, source: true, usage: "not-analyzed" } });
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].nodes.length, 1);
  assert.equal(graphNeighbors(result, nodeId("11999"), { direction: "dependents", transitive: true }).length, 11999);
});
