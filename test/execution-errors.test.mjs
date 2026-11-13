import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { stubPackageManagers } from "../fixtures/cli/package-manager-stubs.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const terminal = new URL("../fixtures/cli/simulate-terminal.mjs", import.meta.url).href;
const config = JSON.stringify({ aliases: { ui: "@/components/ui" } });
const store = ".compadcn/custom-presets.json";

function run(cwd, args, extra = {}, simulateTerminal = true) {
  const env = { ...stubPackageManagers(cwd), ...extra };
  const result = spawnSync(process.execPath, [
    ...(simulateTerminal ? ["--import", terminal] : []), cli, ...args,
  ], { cwd, env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  return { ...result, argsFile: env.SHADCN_PLUS_ARGS_FILE };
}

function project(t, files = {}) {
  return createProject(t, {
    "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
    "components.json": config,
    ...files,
  });
}

test("missing presets exit nonzero instead of printing an error and succeeding", (t) => {
  const cwd = project(t);
  const result = run(cwd, ["preset", "show", "missing"], {}, false);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR PRESET_NOT_FOUND:/);
  assert.equal(existsSync(join(cwd, ".compadcn")), false);
});

for (const name of ["constructor", "__proto__", "toString"]) {
  test(`inherited object properties are not installed presets: ${name}`, (t) => {
    const cwd = project(t);
    for (const action of ["show", "delete"]) {
      const result = run(cwd, ["preset", action, name]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /ERROR PRESET_NOT_FOUND:/);
      assert.doesNotMatch(result.stdout, /deleted successfully/);
    }
    assert.equal(existsSync(join(cwd, ".compadcn")), false);
  });
}

test("an actual custom preset with an inherited-property name still resolves", (t) => {
  const cwd = project(t, { [store]: JSON.stringify({ presets: {
    constructor: { id: "constructor", label: "Custom constructor", description: "", components: [], createdAt: "2026-11-10" },
  } }) });
  const result = run(cwd, ["preset", "show", "constructor"], {}, false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Custom constructor/);
});

test("listing presets does not create storage on a read-only path", (t) => {
  const cwd = project(t);
  const result = run(cwd, ["preset", "list"], {}, false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, ".compadcn")), false);
});

for (const content of ["{", '{"presets":[]}', '{"presets":{"broken":null}}']) {
  test(`invalid preset storage is reported and preserved: ${content}`, (t) => {
    const cwd = project(t, { [store]: content });
    const result = run(cwd, ["preset", "list"], {}, false);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ERROR PRESET_STORAGE_INVALID:/);
    assert.equal(readFileSync(join(cwd, store), "utf8"), content);
  });
}

test("builtin-only listing does not depend on a damaged custom store", (t) => {
  const cwd = project(t, { [store]: "{" });
  const result = run(cwd, ["preset", "list", "--builtin"], {}, false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Core Components/);
});

test("creating a preset cannot replace a damaged store with empty data", (t) => {
  const cwd = project(t, { [store]: "{" });
  const result = run(cwd, ["preset", "create", "Fresh", "button", "--description", "Demo"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR PRESET_STORAGE_INVALID:/);
  assert.equal(readFileSync(join(cwd, store), "utf8"), "{");
});

test("missing component configuration stops installation before launching a package manager", (t) => {
  const cwd = createProject(t,{"package.json":"{}"});
  const result = run(cwd, ["add", "button"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR CONFIG_NOT_FOUND:/);
  assert.equal(existsSync(result.argsFile), false);
});




for (const args of [["preset", "install", "core"]]) {
  test(`package-manager failures propagate to the CLI: ${args.join(" ")}`, (t) => {
    const cwd = project(t);
    const result = run(cwd, args, { SHADCN_PLUS_PM_EXIT: "7" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ERROR INSTALL_FAILED:/);
    assert.match(result.stderr, /Simulated package-manager failure/);
    assert.doesNotMatch(result.stdout, /installed successfully/);
  });
}


for (const flag of ["--css-variables", "--no-css-variables"]) {
  test(`obsolete ${flag} is rejected before an installer starts`, (t) => {
    const cwd = project(t);
    const result = run(cwd, ["add", "button", flag]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ERROR INVALID_ARGUMENT: unknown option/);
    assert.equal(existsSync(result.argsFile), false);
  });
}

test("deleting a preset by its display label deletes its resolved id", (t) => {
  const cwd = project(t, { [store]: JSON.stringify({ presets: {
    custom: { id: "custom", label: "My Custom Preset", description: "", components: [], createdAt: "2026-11-10" },
  } }) });
  const result = run(cwd, ["preset", "delete", "my custom preset"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, store), "utf8")), { presets: {} });
});

test("normalized preset ids cannot overwrite another custom preset", (t) => {
  const content = JSON.stringify({ presets: {
    "my-preset": { id: "my-preset", label: "Existing", description: "", components: [], createdAt: "2026-11-10" },
  } });
  const cwd = project(t, { [store]: content });
  const result = run(cwd, ["preset", "create", "my--preset", "button", "--description", "Copy"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR PRESET_EXISTS:/);
  assert.equal(readFileSync(join(cwd, store), "utf8"), content);
});

test("a name without a usable preset id cannot create storage", (t) => {
  const cwd = project(t);
  const result = run(cwd, ["preset", "create", "!!!", "button", "--description", "Demo"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR INVALID_PRESET_NAME:/);
  assert.equal(existsSync(join(cwd, ".compadcn")), false);
});

test("cancelling preset creation never reports success or writes storage", (t) => {
  const cwd = project(t);
  const result = run(cwd, ["preset", "create", "Fresh", "button"], { SHADCN_PLUS_CANCEL_TEXT: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /created successfully/);
  assert.equal(existsSync(join(cwd, ".compadcn")), false);
});
