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

test("invalid configuration does not become an empty component inventory", (t) => {
  const cwd = project(t, { "components.json": '{"aliases":{}}' });
  const result = run(cwd, ["lint"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR CONFIG_INVALID:/);
});

test("unknown component requests fail instead of reporting successful no-ops", (t) => {
  const cwd = project(t);
  for (const [command, code] of [["remove", "COMPONENT_NOT_INSTALLED"]]) {
    const result = run(cwd, [command, "unknown-component"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`ERROR ${code}:`));
    assert.equal(existsSync(result.argsFile), false);
  }
});

test("dependency conflicts leave component files intact and exit nonzero", (t) => {
  const cwd = project(t, {
    "src/components/ui/button.tsx": "export const Button=()=>null;",
    "src/components/ui/calendar.tsx": "export const Calendar=()=>null;",
  });
  const result = run(cwd, ["remove", "button"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR DEPENDENCY_CONFLICT:/);
  assert.equal(existsSync(join(cwd, "src/components/ui/button.tsx")), true);
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

test("dependency-removal failure cannot produce a successful cleanup message", (t) => {
  const cwd = project(t, { "src/components/ui/command.tsx": "export const Command=()=>null;" });
  const result = run(cwd, ["remove", "command"], {
    SHADCN_PLUS_SELECT_DEPS: "1", SHADCN_PLUS_PM_EXIT: "7",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR DEPENDENCY_REMOVAL_FAILED:/);
  assert.match(result.stderr, /Simulated package-manager failure/);
  assert.doesNotMatch(result.stdout, /Successfully removed/);
  const invocation = JSON.parse(readFileSync(result.argsFile, "utf8"));
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["uninstall", "cmdk"]);
});

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

test("unreadable source aborts linting instead of offering removal", (t) => {
  const cwd = project(t, { "src/components/ui/button.tsx": "export const Button=()=>null;", "src/app/page.tsx": "" });
  const result = run(cwd, ["lint"], { SHADCN_PLUS_READ_FAIL: "page.tsx" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR SOURCE_SCAN_FAILED:/);
  assert.equal(existsSync(join(cwd, "src/components/ui/button.tsx")), true);
});

test("partial file-removal failure rejects instead of returning success", (t) => {
  const cwd = project(t, { "src/components/ui/card.tsx": "", "src/components/ui/button.tsx/keep.tsx": "" });
  const module = new URL("../dist/utils/removeComponents.js", import.meta.url).href;
  const script = `const { removeComponents } = await import(${JSON.stringify(module)});
    try { await removeComponents(["card", "button"]); }
    catch (error) { console.error(error.code); process.exitCode=2; }`;
  const result = spawnSync(process.execPath, ["--import", terminal, "--input-type=module", "--eval", script],
    { cwd, env: stubPackageManagers(cwd), encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /COMPONENT_REMOVAL_FAILED/);
  assert.equal(existsSync(join(cwd, "src/components/ui/button.tsx/keep.tsx")), true);
});

test("import cleanup does not silently skip an unreadable source file", (t) => {
  const content = 'import { Button } from "@/components/ui/button";';
  const cwd = project(t, { "src/app/page.tsx": content });
  const module = new URL("../dist/utils/removeImports.js", import.meta.url).href;
  const script = `const { removeImportsFromFiles } = await import(${JSON.stringify(module)});
    try { await removeImportsFromFiles(["button"]); }
    catch (error) { console.error(error.code); process.exitCode=2; }`;
  const result = spawnSync(process.execPath, ["--import", terminal, "--input-type=module", "--eval", script],
    { cwd, env: { ...stubPackageManagers(cwd), SHADCN_PLUS_READ_FAIL: "page.tsx" }, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /IMPORT_CLEANUP_FAILED/);
  assert.equal(readFileSync(join(cwd, "src/app/page.tsx"), "utf8"), content);
});
