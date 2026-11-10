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
