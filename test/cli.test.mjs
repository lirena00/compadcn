import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const cli = fileURLToPath(new URL(`../${metadata.bin["shadcn-plus"]}`, import.meta.url));
const blocker = new URL(
  "../fixtures/cli/register-block-workflows.mjs", import.meta.url
).href;

function node(args) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

for (const args of [["--help"], ["add", "--help"], ["preset", "list", "--help"]]) {
  test(`help stays lightweight: ${args.join(" ")}`, () => {
    const result = node(["--import", blocker, cli, ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: shadcn-plus/);
    assert.equal(result.stderr, "");
  });
}

test("the executable reports the package version without loading workflows", () => {
  const result = node(["--import", blocker, cli, "--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${metadata.version}\n`);
  assert.equal(result.stderr, "");
});

test("importing the public API does not parse arguments, prompt, or print", () => {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const script = `const api = await import(${JSON.stringify(entry)});
    const program = api.createProgram();
    if (program.name() !== "shadcn-plus" || typeof api.runCli !== "function") {
      throw new Error("Missing CLI factory or runner");
    }
    console.log("imported");`;
  const result = node(["--import", blocker, "--input-type=module", "--eval", script, "--", "--unexpected"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "imported\n");
  assert.equal(result.stderr, "");
});

test("preset list documents usable long and short filter flags", () => {
  const result = node([cli, "preset", "list", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-b, --builtin/);
  assert.match(result.stdout, /-c, --custom/);
});

test("an existing noninteractive preset command still dispatches", () => {
  const result = node([cli, "preset", "show", "core"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Core Components/);
  assert.match(result.stdout, /Button/);
});

test("JSON version output is structured and stays lightweight", () => {
  const result = node(["--import", blocker, cli, "--json", "--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    toolVersion: metadata.version,
    status: "completed",
    data: { name: "shadcn-plus", version: metadata.version },
  });
  assert.equal(result.stderr, "");
});

test("JSON subcommand help does not load its workflow", () => {
  const result = node(["--import", blocker, cli, "--json", "preset", "show", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "completed");
  assert.match(payload.data.help, /Usage: shadcn-plus preset show/);
  assert.equal(result.stderr, "");
});

for (const args of [["--json", "not-a-command"], ["--json", "preset", "show"], ["preset", "show", "core", "--json", "--unknown"]]) {
  test(`parser errors use JSON and exit 2: ${args.join(" ")}`, () => {
    const result = node(["--import", blocker, cli, ...args]);
    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "error");
    assert.equal(payload.error.code, "INVALID_ARGUMENT");
    assert.equal(result.stderr, "");
  });
}

test("ordinary parser errors go to stderr without a stack trace", () => {
  const result = node([cli, "preset", "show"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^ERROR INVALID_ARGUMENT: missing required argument/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("unsupported JSON workflows fail before importing or executing them", () => {
  const result = node(["--import", blocker, cli, "preset", "show", "core", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "OUTPUT_MODE_UNSUPPORTED");
  assert.equal(result.stderr, "");
});

test("unsupported plain workflows fail explicitly", () => {
  const result = node(["--import", blocker, cli, "--plain", "preset", "show", "core"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^ERROR OUTPUT_MODE_UNSUPPORTED:/);
});

for (const args of [["add", "button"], ["preset"], ["preset", "install", "core"], ["preset", "create", "demo", "button"], ["preset", "delete", "demo"]]) {
  test(`noninteractive legacy workflows fail before prompting or writing: ${args.join(" ")}`, () => {
    const result = node(["--import", blocker, cli, "--no-interactive", ...args]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^ERROR INTERACTIVE_REQUIRED:/);
  });
}

test("conflicting output flags produce one structured error", () => {
  const result = node([cli, "--json", "--plain", "--help"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_OPTIONS");
  assert.equal(result.stderr, "");
});

test("an empty invocation shows help without starting a workflow", () => {
  const result = node(["--import", blocker, cli]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: shadcn-plus/);
});

test("the library runner returns an exit code without exiting its caller", () => {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const script = `const { runCli } = await import(${JSON.stringify(entry)});
    const code = await runCli(["node", "shadcn-plus", "--json", "--version"]);
    console.log("returned:" + code);`;
  const result = node(["--import", blocker, "--input-type=module", "--eval", script]);
  assert.equal(result.status, 0, result.stderr);
  const [payload, returned] = result.stdout.trim().split("\n");
  assert.equal(JSON.parse(payload).data.version, metadata.version);
  assert.equal(returned, "returned:0");
  assert.equal(result.stderr, "");
});
