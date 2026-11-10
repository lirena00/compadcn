import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const blocker = new URL("../fixtures/cli/register-block-workflows.mjs", import.meta.url).href;
const terminal = new URL("../fixtures/cli/simulate-terminal.mjs", import.meta.url).href;
const button = { name: "button", type: "registry:ui", files: [{ path: "ui/button.tsx", type: "registry:ui", content: "export const Button=1;" }] };

async function fixture(t, extra = {}) {
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([button]) : button));
  const root = createProject(t, { "package.json": '{"dependencies":{"react":"19"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json` } }),
    "ui/button.tsx": button.files[0].content, "src/app.tsx": 'import "../ui/button";', ...extra });
  return { root, server };
}

async function run(cwd, args, imports = [blocker]) {
  const env = { ...process.env, NO_COLOR: "1", HOME: cwd, USERPROFILE: cwd };
  delete env.FORCE_COLOR;
  try {
    const result = await execute(process.execPath, [...imports.flatMap((value) => ["--import", value]), cli, ...args], { cwd, env, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    return { ...result, status: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, status: error.code };
  }
}

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath, entry.name); return [relative(root, path), readFileSync(path, "base64")];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

for (const flags of [[], ["--plain"], ["--json"], ["--no-interactive", "--json"]]) {
  test(`graph supports noninteractive output: ${flags.join(" ") || "default"}`, async (t) => {
    const { root } = await fixture(t);
    const result = await run(root, ["graph", "--no-cache", ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (flags.includes("--json")) {
      const response = JSON.parse(result.stdout);
      assert.equal(response.status, "completed");
      assert.equal(response.data.graphVersion, 1);
      assert.equal(response.data.counts.localFiles, 2);
    } else { assert.match(result.stdout, /Graph scope: installed/); assert.doesNotMatch(result.stdout, /\u001b\[/); }
  });
}

test("Mermaid stdout is a diagram and JSON can include the same artifact in a TTY", async (t) => {
  const { root } = await fixture(t);
  const text = await run(root, ["graph", "--no-cache", "--mermaid"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^flowchart LR\n/);
  assert.match(text.stdout, /file-import/);
  const structured = await run(root, ["--json", "graph", "--mermaid", "--no-cache"], [terminal, blocker]);
  assert.equal(structured.status, 0, structured.stderr);
  const graph = JSON.parse(structured.stdout).data;
  assert.equal(graph.mermaid, text.stdout);
});

test("incomplete graph JSON retains source errors and partial edges with exit 2", async (t) => {
  const { root } = await fixture(t, { "src/computed.ts": "import(process.env.COMPONENT);" });
  const result = await run(root, ["graph", "--json", "--no-cache"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, "GRAPH_INCOMPLETE");
  assert.equal(response.error.details.graph.coverage.source, false);
  assert.ok(response.error.details.graph.edges.some(({ status }) => status === "unresolved"));
  const diagram = await run(root, ["graph", "--mermaid", "--no-cache"]);
  assert.equal(diagram.status, 2);
  assert.match(diagram.stdout, /^flowchart LR/);
  assert.match(diagram.stderr, /^ERROR GRAPH_INCOMPLETE:/);
});

test("focus and reverse traversal expose the application that imports a component", async (t) => {
  const { root } = await fixture(t);
  const result = await run(root, ["graph", "--focus", "ui/button.tsx", "--reverse", "--transitive", "--json", "--no-cache"]);
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout).data;
  assert.equal(graph.view.direction, "dependents");
  assert.ok(graph.nodes.some(({ path }) => path === join(root, "src/app.tsx")));
});

test("graph validates options before fetching and leaves project files unchanged", async (t) => {
  const { root, server } = await fixture(t);
  const before = snapshot(root);
  for (const flags of [["--scope", "invalid"], ["--max-items", "0"], ["--max-files", "0"], ["--reverse"], ["--transitive"], ["--offline", "--refresh"]]) {
    const result = await run(root, ["graph", "--json", ...flags]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_OPTIONS");
  }
  assert.equal(server.requests.length, 0);
  const good = await run(root, ["graph", "--json", "--no-cache"]);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(snapshot(root), before);
});

test("help and API import do not initialize TypeScript, scan files or fetch catalogs", async (t) => {
  const { root, server } = await fixture(t);
  const result = await run(root, ["--json", "graph", "--help"]);
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).data.help, /--mermaid/);
  assert.match(JSON.parse(result.stdout).data.help, /--focus <reference>/);
  const api = await import(new URL("../dist/index.js", import.meta.url).href);
  for (const name of ["buildDependencyGraph", "graphNeighbors", "selectGraph", "formatMermaid"]) assert.equal(typeof api[name], "function");
  assert.equal(server.requests.length, 0);
});
