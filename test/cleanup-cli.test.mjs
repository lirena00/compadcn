import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cleanupProject, componentBytes } from "../fixtures/cleanup/project.mjs";
import { createCleanupPlan } from "../dist/changes/build.js";
import { writeArtifact } from "../dist/changes/io.js";
import { discoverProject } from "../dist/project/discover.js";

const execute = promisify(execFile), cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const blocker = new URL("../fixtures/cli/register-block-workflows.mjs", import.meta.url).href;
const analysisBlocker = new URL("../fixtures/cli/register-block-analysis.mjs", import.meta.url).href;
async function run(root, args, env, imports = [blocker]) {
  const settings = { ...env, NO_COLOR: "1" }; delete settings.FORCE_COLOR;
  try { return { ...await execute(process.execPath, [...imports.flatMap(path => ["--import", path]), cli, ...args], { cwd: root, env: settings, encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024 }), status: 0 }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
}
async function fixture(t, values) {
  const f = await cleanupProject(t, values), artifact = join(f.root, ".shadcn-plus/plan.json");
  const plan = await createCleanupPlan({ ...f.options, mode: "remove", targets: f.targets, includeUnverified: true, artifactPath: artifact });
  await writeArtifact(plan, artifact, discoverProject(f.options));
  return { ...f, artifact, plan };
}

test("JSON apply, read-only inspection and restore share one operation receipt", async t => {
  const { root, env, artifact, server } = await fixture(t);
  const applied = await run(root, ["apply", "--plan", artifact, "--yes", "--verify", "--json", "--no-cache"], env);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr); assert.equal(applied.stderr, "");
  const operation = JSON.parse(applied.stdout).data.operation; assert.equal(operation.status, "completed");
  assert.equal(existsSync(join(root, "ui/unused.tsx")), false); assert.doesNotMatch(applied.stdout, /cleanup-private-token/);
  const requests = server.requests.length, journal = readFileSync(operation.journalPath);
  const inspected = await run(root, ["operation", operation.operationId, "--json"], env);
  assert.equal(inspected.status, 0, inspected.stdout); assert.equal(JSON.parse(inspected.stdout).data.operation.planId, operation.planId);
  assert.deepEqual(readFileSync(operation.journalPath), journal); assert.equal(server.requests.length, requests);
  const restored = await run(root, ["restore", operation.operationId, "--yes", "--json"], env);
  assert.equal(restored.status, 0, restored.stdout); assert.equal(JSON.parse(restored.stdout).data.operation.status, "restored");
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes); assert.equal(server.requests.length, requests);
});

test("noninteractive apply/restore require explicit consent before analysis or mutation", async t => {
  const { root, env, artifact, server } = await fixture(t), requests = server.requests.length;
  const apply = await run(root, ["apply", "--plan", artifact, "--json"], env);
  assert.equal(apply.status, 2); assert.equal(JSON.parse(apply.stdout).error.code, "INTERACTIVE_REQUIRED");
  const restore = await run(root, ["restore", "b236dd34-4137-4f4f-85a8-215caa8fa216", "--plain"], env);
  assert.equal(restore.status, 2); assert.match(restore.stderr, /INTERACTIVE_REQUIRED/);
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes); assert.equal(server.requests.length, requests);
  assert.equal(existsSync(join(root, ".shadcn-plus/cleanup.lock")), false);
});

test("stale plans and invalid application limits never delete a component", async t => {
  const { root, env, artifact, server } = await fixture(t); const requests = server.requests.length;
  const invalid = await run(root, ["apply", "--plan", artifact, "--yes", "--verification-timeout", "0", "--json"], env);
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).error.code, "INVALID_OPTIONS");
  writeFileSync(join(root, "src/new.tsx"), 'import "../ui/unused";');
  const stale = await run(root, ["apply", "--plan", artifact, "--yes", "--json"], env);
  assert.equal(stale.status, 2); assert.equal(JSON.parse(stale.stdout).error.code, "PLAN_STALE");
  assert.equal(server.requests.length, requests); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("post-check failures expose recovery on JSON stdout and keep script output private", async t => {
  const { root, env, artifact } = await fixture(t, { scripts: { build: "node verify.cjs" }, extra: { "verify.cjs": 'console.log("script-secret-must-not-leak");process.exit(8);' } });
  const applied = await run(root, ["apply", "--plan", artifact, "--yes", "--json", "--no-cache"], env);
  assert.equal(applied.status, 2); assert.equal(applied.stderr, "");
  const error = JSON.parse(applied.stdout).error; assert.equal(error.code, "CLEANUP_ROLLED_BACK");
  assert.equal(error.details.operation.status, "rolled-back"); assert.ok(error.details.operation.verification.some(step => step.script === "build" && step.exitCode === 8));
  assert.doesNotMatch(applied.stdout, /script-secret-must-not-leak/); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("plain verification failures use stderr with the restorable operation ID", async t => {
  const { root, env, artifact } = await fixture(t, { scripts: { lint: "node verify.cjs" }, extra: { "verify.cjs": "process.exit(4);" } });
  const result = await run(root, ["apply", "--plan", artifact, "--yes", "--precheck", "--plain", "--no-cache"], env);
  assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.match(result.stderr, /^ERROR CLEANUP_PRECHECK_FAILED:/);
  assert.match(result.stderr, /Operation: [a-f0-9-]{36}/); assert.match(result.stderr, /before lint: failed/); assert.doesNotMatch(result.stderr, /\u001b\[/);
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("restore preserves a recreated file and reports a conflict instead of overwriting it", async t => {
  const { root, env, artifact } = await fixture(t);
  const applied = await run(root, ["apply", "--plan", artifact, "--yes", "--json", "--no-cache"], env);
  assert.equal(applied.status, 0, applied.stdout); const id = JSON.parse(applied.stdout).data.operation.operationId;
  writeFileSync(join(root, "ui/unused.tsx"), "replacement from another writer");
  const result = await run(root, ["restore", id, "--yes", "--json"], env);
  assert.equal(result.status, 2); const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "CLEANUP_RECOVERY_REQUIRED"); assert.equal(error.details.operation.conflicts[0].code, "RESTORE_CONFLICT");
  assert.equal(readFileSync(join(root, "ui/unused.tsx"), "utf8"), "replacement from another writer");
});

test("new command help and public API import remain lazy", async t => {
  const { root, env, server } = await cleanupProject(t);
  for (const command of ["apply", "restore", "operation"]) {
    const result = await run(root, [command, "--help", "--json"], env, [blocker, analysisBlocker]);
    assert.equal(result.status, 0, result.stderr); assert.match(JSON.parse(result.stdout).data.help, new RegExp(`Usage: shadcn-plus ${command}`));
  }
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const result = await execute(process.execPath, ["--import", blocker, "--import", analysisBlocker, "--input-type=module", "--eval", `const api=await import(${JSON.stringify(entry)});for(const name of ['applyCleanupPlan','restoreCleanupOperation','inspectCleanupOperation'])if(typeof api[name]!=='function')throw Error(name);console.log('lazy');`], { cwd: root, env, timeout: 10000, encoding: "utf8" });
  assert.equal(result.stdout, "lazy\n"); assert.equal(server.requests.length, 0);
});

test("operation IDs reject paths and restore does not require healthy current configuration", async t => {
  const { root, env, artifact } = await fixture(t);
  const bad = await run(root, ["operation", "../plan.json", "--json"], env);
  assert.equal(bad.status, 2); assert.equal(JSON.parse(bad.stdout).error.code, "OPERATION_ID_INVALID");
  const applied = await run(root, ["apply", "--plan", artifact, "--yes", "--json", "--no-cache"], env); assert.equal(applied.status, 0, applied.stdout);
  const id = JSON.parse(applied.stdout).data.operation.operationId; writeFileSync(join(root, "package.json"), "{broken config");
  const restored = await run(root, ["restore", id, "--yes", "--json"], env);
  assert.equal(restored.status, 0, restored.stdout); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), "{broken config");
});

test("terminal cancellation after mutation returns a failure receipt after recovery", async t => {
  const { root, env, artifact } = await fixture(t, { scripts: { build: "node verify.cjs" }, extra: { "verify.cjs": 'require("node:fs").writeFileSync(".shadcn-plus/check-started", "1");setTimeout(()=>{},10000);' } });
  const script = fileURLToPath(new URL("../fixtures/cli/cancellable-command.mjs", import.meta.url));
  const child = fork(script, ["apply", "--plan", artifact, "--yes", "--json", "--no-cache"], { cwd: root, env, execArgv: ["--import", blocker], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "", listeners;
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.on("message", message => { listeners = message; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 20000;
  while (!existsSync(join(root, ".shadcn-plus/check-started")) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(existsSync(join(root, ".shadcn-plus/check-started")), true, stdout + stderr);
  child.send("cancel"); assert.equal(await exited, 2, stderr);
  const error = JSON.parse(stdout).error; assert.equal(error.code, "CLEANUP_ROLLED_BACK");
  assert.equal(error.details.operation.status, "rolled-back"); assert.ok(error.details.operation.verification.some(step => step.status === "cancelled"));
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes); assert.deepEqual(listeners.after, listeners.before); assert.equal(stderr, "");
});

test("cancellation during revalidation leaves a discoverable cancelled receipt without deleting files", async t => {
  const { root, env, artifact, server } = await fixture(t), requests = server.requests.length;
  const script = fileURLToPath(new URL("../fixtures/cli/cancellable-command.mjs", import.meta.url));
  const child = fork(script, ["apply", "--plan", artifact, "--yes", "--json", "--no-cache"], { cwd: root, env, execArgv: ["--import", blocker], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 10000;
  while (server.requests.length === requests && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(server.requests.length > requests, stdout + stderr); child.send("cancel");
  assert.equal(await exited, 0, stdout + stderr); const result = JSON.parse(stdout); assert.equal(result.status, "cancelled");
  const id = result.data.message.match(/[a-f0-9-]{36}/)[0];
  const inspected = await run(root, ["operation", id, "--json"], env);
  assert.equal(inspected.status, 0, inspected.stdout); assert.equal(JSON.parse(inspected.stdout).data.operation.status, "cancelled");
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes); assert.equal(existsSync(join(root, ".shadcn-plus/cleanup.lock")), false);
});
