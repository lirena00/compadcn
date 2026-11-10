import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const blocker = new URL("../fixtures/cli/register-block-workflows.mjs", import.meta.url).href;
const terminal = new URL("../fixtures/cli/simulate-terminal.mjs", import.meta.url).href;
const button = { name: "button", type: "registry:ui", files: [{ path: "ui/button.tsx", type: "registry:ui", content: "export {};" }] };

function project(t, url, extra = {}) {
  return createProject(t, {
    "package.json": '{"dependencies":{"react":"19","vite":"7"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${url}/{name}.json` } }),
    "ui/button.tsx": "export {};", ...extra,
  });
}

async function run(cwd, args, { imports = [blocker], env: extra = {} } = {}) {
  const env = { ...process.env, NO_COLOR: "1", HOME: cwd, USERPROFILE: cwd, ...extra };
  delete env.FORCE_COLOR;
  try {
    const result = await execute(process.execPath, [...imports.flatMap((value) => ["--import", value]), cli, ...args], {
      cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    });
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
  test(`inventory works without terminal workflows: ${flags.join(" ") || "default plain"}`, async (t) => {
    const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([button]) : button));
    const root = project(t, server.url);
    const result = await run(root, ["inventory", "--no-cache", ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (flags.includes("--json")) {
      const response = JSON.parse(result.stdout);
      assert.equal(response.status, "completed");
      assert.equal(response.schemaVersion, 1);
      assert.equal(response.data.counts.localFiles, 1);
      assert.equal(response.data.items[0].originConfidence, "candidate");
    } else {
      assert.match(result.stdout, /Catalog: 1 unique items/);
      assert.match(result.stdout, /Item candidates: 1 present/);
      assert.doesNotMatch(result.stdout, /\u001b\[/);
    }
  });
}

test("inventory JSON stays clean in a TTY and cwd can select another project", async (t) => {
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([button]) : button));
  const root = project(t, server.url);
  const elsewhere = createProject(t);
  const result = await run(elsewhere, ["--json", "inventory", "--cwd", root, "--no-cache"], { imports: [terminal, blocker] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.projectRoot, root);
});

test("partial JSON output preserves healthy files and per-source failure status", async (t) => {
  const server = await registryServer(t, (req, res) => {
    if (req.url.startsWith("/private/")) { res.writeHead(403); res.end(); }
    else json(res, req.url.includes("registry.json") ? catalog([button]) : button);
  });
  const root = project(t, server.url, { "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/{name}.json`, "@private": `${server.url}/private/{name}.json` } }) });
  const result = await run(root, ["inventory", "--json", "--no-cache"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, "INVENTORY_INCOMPLETE");
  assert.equal(response.error.details.report.counts.localFiles, 1);
  assert.ok(response.error.details.report.sources.some(({ diagnostics }) => diagnostics.some(({ code }) => code === "REGISTRY_FORBIDDEN")));
});

test("plain incomplete output and invalid options return exit 2", async (t) => {
  const root = project(t, "http://127.0.0.1:1");
  const plain = await run(root, ["inventory", "--offline", "--no-cache", "--plain"]);
  assert.equal(plain.status, 2);
  assert.equal(plain.stdout, "");
  assert.match(plain.stderr, /^ERROR INVENTORY_INCOMPLETE:/);
  for (const args of [["--refresh", "--offline"], ["--concurrency", "0"], ["--timeout", "0"], ["--item", "button"], ["--no-cache", "--cache-dir", root]]) {
    const result = await run(root, ["inventory", "--json", ...args]);
    assert.equal(result.status, 2);
    assert.ok(["INVALID_OPTIONS", "INVALID_ARGUMENT"].includes(JSON.parse(result.stdout).error.code));
  }
});

test("inventory does not change project files or print authentication values", async (t) => {
  const server = await registryServer(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-token");
    json(res, req.url.includes("registry.json") ? catalog([button]) : button);
  });
  const root = project(t, server.url, {
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": { url: `${server.url}/{name}.json?token=private-token`, headers: { Authorization: "Bearer ${REGISTRY_TOKEN}" } } } }),
  });
  const cache = createProject(t);
  const before = snapshot(root);
  const result = await run(root, ["inventory", "--json", "--cache-dir", cache], { env: { REGISTRY_TOKEN: "private-token" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes("private-token"), false);
  assert.deepEqual(snapshot(root), before);
});

test("help and public API import remain lazy and show real inventory options", async (t) => {
  const root = createProject(t);
  const help = await run(root, ["--json", "inventory", "--help"]);
  assert.equal(help.status, 0);
  const text = JSON.parse(help.stdout).data.help;
  assert.match(text, /--workspace/);
  assert.match(text, /--item <address>/);
  const { buildInventory } = await import(new URL("../dist/index.js", import.meta.url).href);
  assert.equal(typeof buildInventory, "function");
});
