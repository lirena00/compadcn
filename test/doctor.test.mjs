import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const blocker = new URL("../fixtures/cli/register-block-workflows.mjs", import.meta.url).href;
const api = new URL("../dist/index.js", import.meta.url).href;
const terminal = new URL("../fixtures/cli/simulate-terminal.mjs", import.meta.url).href;

function project(t, overrides = {}) {
  return createProject(t, {
    "package.json": '{"name":"web","dependencies":{"next":"16","react":"19"},"packageManager":"pnpm@10"}',
    "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    "components.json": '{"aliases":{"ui":"@/components/ui"}}',
    "src/components/ui/button.tsx": "export const Button = () => null;",
    ...overrides,
  });
}

function run(cwd, args, imports = [blocker]) {
  const env = { ...process.env, NO_COLOR: "1", HOME: cwd, USERPROFILE: cwd };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, [...imports.flatMap((url) => ["--import", url]), cli, ...args], {
    cwd, env, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex")];
    }).sort(([a], [b]) => a.localeCompare(b)));
}

for (const args of [["doctor"], ["doctor", "--plain"], ["--no-interactive", "doctor"]]) {
  test(`doctor works without prompts: ${args.join(" ")}`, (t) => {
    const cwd = project(t);
    const result = run(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Framework: next/);
    assert.match(result.stdout, /Alias ui:/);
    assert.match(result.stdout, /Discovery complete/);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
    assert.equal(result.stderr, "");
  });
}

test("doctor JSON is a single response without terminal workflow imports", (t) => {
  const cwd = project(t);
  const result = run(cwd, ["doctor", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.status, "completed");
  assert.equal(response.data.ready, true);
  assert.equal(response.data.projectRoot, cwd);
  assert.equal(response.data.components.resolvedAliases.ui.path, join(cwd, "src/components/ui"));
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(result.stderr, "");
});

test("cwd selects a package from elsewhere, including relative nested folders", (t) => {
  const root = createProject(t, { "package.json": "{}" });
  const target = project(t);
  const relativeTarget = relative(root, join(target, "src/components"));
  const result = run(root, ["--json", "doctor", "--cwd", relativeTarget]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.projectRoot, target);
});

test("incomplete JSON discovery returns all diagnostics and partial context on exit 2", (t) => {
  const cwd = project(t, { "tsconfig.json": "{}", "yarn.lock": "" });
  const result = run(cwd, ["--json", "doctor"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "error");
  assert.equal(response.error.code, "PROJECT_NOT_READY");
  const context = response.error.details.context;
  assert.equal(context.ready, false);
  assert.equal(context.framework, "next");
  assert.ok(context.diagnostics.some(({ code }) => code === "ALIAS_UNRESOLVED"));
  assert.ok(context.diagnostics.some(({ code }) => code === "PACKAGE_MANAGER_CONFLICT"));
});

test("plain incomplete discovery goes to stderr with actionable diagnostic codes", (t) => {
  const cwd = project(t, { "components.json": "{" });
  const result = run(cwd, ["doctor", "--plain"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^ERROR PROJECT_NOT_READY:/);
  assert.match(result.stderr, /CONFIG_INVALID/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("invalid cwd and parser errors respect the JSON failure contract", (t) => {
  const cwd = project(t);
  for (const [args, code] of [
    [["doctor", "--cwd", "missing", "--json"], "CWD_INVALID"],
    [["doctor", "--cwd", "--json"], "INVALID_ARGUMENT"],
    [["doctor", "--json", "--plain"], "INVALID_OPTIONS"],
  ]) {
    const result = run(cwd, args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.equal(result.stderr, "");
  }
});

test("doctor help stays lightweight and documents cwd", (t) => {
  const result = run(project(t), ["--json", "doctor", "--help"]);
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).data.help, /-c, --cwd <path>/);
});

test("doctor is read-only on success and failure and hides registry credentials", (t) => {
  const cwd = project(t, {
    "components.json": '{"aliases":{"ui":"@/components/ui"},"registries":{"@private":{"url":"https://private.example/{name}.json?token=secret-value","headers":{"Authorization":"secret-value"}}}}',
  });
  const before = snapshot(cwd);
  for (const args of [["doctor", "--json"], ["doctor", "--cwd", "src", "--plain"], ["doctor", "--cwd", "missing", "--json"]]) {
    const result = run(cwd, args);
    assert.equal((result.stdout + result.stderr).includes("secret-value"), false);
    assert.deepEqual(snapshot(cwd), before);
  }
});

test("TTY JSON doctor has no title or prompt output", (t) => {
  const result = run(project(t), ["--json", "doctor"], [terminal, blocker]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "completed");
});

test("the public discovery API is lazy, returns diagnostics and preserves the caller cwd", async (t) => {
  const cwd = project(t);
  const before = process.cwd();
  const { discoverProject } = await import(api);
  assert.equal((await discoverProject({ cwd, env: {} })).ready, true);
  assert.equal(process.cwd(), before);
});
