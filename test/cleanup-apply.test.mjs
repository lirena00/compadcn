import assert from "node:assert/strict";
import { appendFileSync, existsSync, linkSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, chmodSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cleanupProject, componentBytes } from "../fixtures/cleanup/project.mjs";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { createCleanupPlan } from "../dist/changes/build.js";
import { applyCleanupPlan } from "../dist/changes/apply.js";
import { inspectCleanupOperation, restoreCleanupOperation } from "../dist/changes/restore.js";
import { acquireCleanupLock } from "../dist/changes/journal.js";
import { portablePath } from "../dist/changes/paths.js";
import { withId } from "../dist/changes/schema.js";
import { CommandCancelled } from "../dist/core/cancellation.js";

async function fixture(t, values) {
  const f = await cleanupProject(t, values);
  return { ...f, plan: await createCleanupPlan({ ...f.options, mode: "remove", targets: f.targets, includeUnverified: true }) };
}

test("private registry cleanup applies only exact files and restores lossless bytes and metadata", async t => {
  const { root, options, plan } = await fixture(t, { extra: { "unrelated.txt": "dirty work", "package-lock.json": '{"lockfileVersion":3}' } });
  assert.equal(plan.status, "ready", JSON.stringify(plan.diagnostics));
  const original = statSync(join(root, "ui/unused.tsx")), metadata = readFileSync(join(root, "package.json"));
  const receipt = await applyCleanupPlan(plan, options);
  assert.equal(receipt.status, "completed", JSON.stringify(receipt)); assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.changedPaths, ["ui/unused.tsx"]); assert.equal(existsSync(join(root, "ui/unused.tsx")), false);
  assert.equal(receipt.verification.length, 3); assert.ok(receipt.verification.every(step => step.status === "not-configured"));
  assert.deepEqual(readFileSync(join(root, "ui/used.tsx")), componentBytes); assert.deepEqual(readFileSync(join(root, "package.json")), metadata);
  assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "dirty work");
  assert.deepEqual((await inspectCleanupOperation(receipt.operationId, options)).changedPaths, receipt.changedPaths);
  const restored = await restoreCleanupOperation(receipt.operationId, options);
  assert.equal(restored.status, "restored"); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
  const current = statSync(join(root, "ui/unused.tsx")); assert.equal(current.mode & 0o777, original.mode & 0o777); assert.ok(Math.abs(current.mtimeMs - original.mtimeMs) < 2);
  assert.equal((await restoreCleanupOperation(receipt.operationId, options)).status, "restored");
  assert.equal(existsSync(join(root, ".shadcn-plus/cleanup.lock")), false);
});

test("stale plans leave a rejected receipt without deletions; blocked plans do not start", async t => {
  const { root, options, plan } = await fixture(t);
  writeFileSync(join(root, "src/new.tsx"), 'import "../ui/unused";');
  await assert.rejects(applyCleanupPlan(plan, options), error => error.code === "PLAN_STALE" && error.details.operation.status === "rejected");
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
  assert.equal(readdirSync(join(root, ".shadcn-plus/operations")).length, 1);
  const blocked = await createCleanupPlan(options); await assert.rejects(applyCleanupPlan(blocked, options), { code: "PLAN_NOT_READY" });
});

test("new consumers during mutation cause rollback while preserving the added file", async t => {
  const { root, options, plan } = await fixture(t, { unused: ["a", "b"] }); let edited = false;
  const result = await applyCleanupPlan(plan, { ...options, onProgress(event) { if (event.stage === "application" && event.state === "complete" && !edited) { edited = true; writeFileSync(join(root, "src/new.tsx"), 'import "../ui/a";'); } } });
  assert.equal(result.status, "rolled-back", JSON.stringify(result)); assert.equal(result.changedPaths.length, 2);
  assert.ok(result.diagnostics.some(d => d.code === "CLEANUP_SCOPE_CHANGED"));
  assert.deepEqual(readFileSync(join(root, "ui/a.tsx")), componentBytes); assert.deepEqual(readFileSync(join(root, "ui/b.tsx")), componentBytes);
  assert.match(readFileSync(join(root, "src/new.tsx"), "utf8"), /ui\/a/);
});

test("a concurrently recreated target is preserved and explicitly reported for recovery", async t => {
  const { root, options, plan } = await fixture(t); let edited = false;
  const result = await applyCleanupPlan(plan, { ...options, onProgress(event) { if (event.stage === "application" && event.state === "complete" && !edited) { edited = true; writeFileSync(join(root, "ui/unused.tsx"), "other writer"); throw new Error("stop after mutation"); } } });
  assert.equal(result.status, "recovery-required"); assert.equal(result.conflicts[0].path, "ui/unused.tsx");
  assert.equal(readFileSync(join(root, "ui/unused.tsx"), "utf8"), "other writer");
  assert.equal((await restoreCleanupOperation(result.operationId, options)).status, "recovery-required");
  unlinkSync(join(root, "ui/unused.tsx"));
  assert.equal((await restoreCleanupOperation(result.operationId, options)).status, "restored");
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("required checks run before/after when requested and a regression restores the deletion", async t => {
  const { root, options, plan } = await fixture(t, { scripts: { typecheck: "node verify.cjs" }, extra: { "verify.cjs": 'const fs=require("node:fs");console.log("verification-output-secret");process.exit(fs.existsSync("ui/unused.tsx")?0:7);' } });
  const result = await applyCleanupPlan(plan, { ...options, precheck: true });
  assert.equal(result.status, "rolled-back", JSON.stringify(result));
  assert.equal(result.verification.find(step => step.phase === "before" && step.script === "typecheck").status, "passed");
  assert.equal(result.verification.find(step => step.phase === "after" && step.script === "typecheck").exitCode, 7);
  assert.doesNotMatch(JSON.stringify(result), /verification-output-secret/); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("pre-existing verification failures stop before deleting files", async t => {
  const { root, options, plan } = await fixture(t, { scripts: { lint: "node verify.cjs" }, extra: { "verify.cjs": "process.exit(9);" } });
  const result = await applyCleanupPlan(plan, { ...options, precheck: true });
  assert.equal(result.status, "precheck-failed"); assert.equal(result.changedPaths.length, 0);
  assert.ok(result.diagnostics.some(d => d.code === "PRECHECK_FAILED")); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

for (const interruption of ["timeout", "cancelled"]) test(`verification ${interruption} settles its process before rollback`, async t => {
  const { root, options, plan } = await fixture(t, { scripts: { build: "node verify.cjs" }, extra: { "verify.cjs": 'require("node:fs").writeFileSync(".shadcn-plus/verification-pid",String(process.pid));setInterval(()=>{},1000);' } });
  const controller = new AbortController();
  const result = await applyCleanupPlan(plan, { ...options, signal: controller.signal, verificationTimeoutMs: interruption === "timeout" ? 700 : 10000,
    onProgress(event) { if (interruption === "cancelled" && event.stage === "verification" && event.state === "start" && event.message.includes("build")) setTimeout(() => controller.abort(), 700); } });
  assert.equal(result.status, "rolled-back", JSON.stringify(result)); assert.ok(result.verification.some(step => step.status === interruption));
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
  if (existsSync(join(root, ".shadcn-plus/verification-pid"))) {
    const pid = Number(readFileSync(join(root, ".shadcn-plus/verification-pid"), "utf8"));
    assert.throws(()=>process.kill(pid,0), error=>error.code==="ESRCH", "Verification descendants must stop before recovery returns");
  }
});

test("recovery rejects corrupted backups without materializing their contents", async t => {
  const { root, options, plan } = await fixture(t), result = await applyCleanupPlan(plan, options);
  writeFileSync(join(root, `.shadcn-plus/operations/${result.operationId}/backups/0.bin`), "corrupted backup");
  const restored = await restoreCleanupOperation(result.operationId, options);
  assert.equal(restored.status, "recovery-required"); assert.equal(restored.conflicts[0].code, "BACKUP_INVALID");
  assert.equal(existsSync(join(root, "ui/unused.tsx")), false);
});

test("an interrupted process can recover intent-only deletions and a truncated journal tail", async t => {
  const { root, options, plan } = await fixture(t), path = join(root, ".shadcn-plus-plan.json"); writeFileSync(path, JSON.stringify(plan));
  const child = fileURLToPath(new URL("../fixtures/cleanup/interrupted.mjs", import.meta.url));
  const id = execFileSync(process.execPath, [child, path], { encoding: "utf8", timeout: 10000 }).trim();
  assert.equal(existsSync(join(root, "ui/unused.tsx")), false);
  const inspected = await inspectCleanupOperation(id, options); assert.equal(inspected.status, "interrupted"); assert.ok(inspected.diagnostics.some(d => d.code === "JOURNAL_TRUNCATED"));
  await assert.rejects(restoreCleanupOperation(id, options), { code: "CLEANUP_LOCKED" });
  const restored = await restoreCleanupOperation(id, { ...options, recoverLock: true }); assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
  assert.ok(readdirSync(join(root, `.shadcn-plus/operations/${id}`)).some(path => path.startsWith("interrupted-tail-")));
});

test("live workspace locks cannot be stolen by a second apply or recovery", async t => {
  const { root, options, plan } = await fixture(t), id = randomUUID(), lock = acquireCleanupLock(root, id);
  try {
    await assert.rejects(applyCleanupPlan(plan, options), { code: "CLEANUP_LOCKED" });
    assert.throws(() => acquireCleanupLock(root, id, true), { code: "CLEANUP_LOCKED" });
  } finally { lock.release(); }
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("journal integrity failures stop recovery before any source write", async t => {
  const { root, options, plan } = await fixture(t), result = await applyCleanupPlan(plan, options);
  appendFileSync(result.journalPath, '{"unknown":true}\n');
  await assert.rejects(restoreCleanupOperation(result.operationId, options), { code: "JOURNAL_INVALID" });
  assert.equal(existsSync(join(root, "ui/unused.tsx")), false);
});

test("cleanup preserves dirty staged/unstaged work and never changes the git index", async t => {
  const { root, options } = await fixture(t, { extra: { "user.txt": "staged" } });
  unlinkSync(join(root, ".git")); execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "--", "user.txt", "ui/unused.tsx"], { stdio: "ignore" });
  writeFileSync(join(root, "user.txt"), "unstaged");
  const index = readFileSync(join(root, ".git/index")), plan = await createCleanupPlan({ ...options, mode: "remove", targets: ["@company/unused"], includeUnverified: true });
  const result = await applyCleanupPlan(plan, options); assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(readFileSync(join(root, ".git/index")), index); assert.equal(readFileSync(join(root, "user.txt"), "utf8"), "unstaged");
  await restoreCleanupOperation(result.operationId, options); assert.deepEqual(readFileSync(join(root, ".git/index")), index);
});

test("mutation paths reject Windows device names and trailing aliases on every platform", () => {
  for (const value of ["ui/con.ts", "ui/AUX.tsx", "ui/unused.tsx.", "ui /unused.tsx", "ui/../unused.tsx"]) assert.equal(portablePath(value), false);
  assert.equal(portablePath("ui/[name]/valid.tsx"), true);
});

test("recovery finishes its own interrupted staging link without changing restored bytes", async t => {
  const { root, options, plan } = await fixture(t), result = await applyCleanupPlan(plan, options);
  const stage = join(root, `ui/.shadcn-plus-restore-${result.operationId}-0.tmp`), target = join(root, "ui/unused.tsx");
  writeFileSync(stage, componentBytes); chmodSync(stage, plan.operations[0].before.mode); linkSync(stage, target);
  assert.equal(statSync(target).nlink, 2);
  const restored = await restoreCleanupOperation(result.operationId, options);
  assert.equal(restored.status, "restored", JSON.stringify(restored)); assert.equal(existsSync(stage), false);
  assert.equal(statSync(target).nlink, 1); assert.deepEqual(readFileSync(target), componentBytes);
});

test("recovery preserves partial staging bytes rather than silently overwriting them", async t => {
  const { root, options, plan } = await fixture(t), result = await applyCleanupPlan(plan, options);
  const stage = join(root, `ui/.shadcn-plus-restore-${result.operationId}-0.tmp`); writeFileSync(stage, "partial or external bytes");
  const restored = await restoreCleanupOperation(result.operationId, options);
  assert.equal(restored.status, "recovery-required"); assert.equal(restored.conflicts[0].code, "RESTORE_STAGING_CONFLICT");
  assert.equal(existsSync(join(root, "ui/unused.tsx")), false); assert.equal(readFileSync(stage, "utf8"), "partial or external bytes");
});

test("apply revalidates eligibility even when a changed artifact has a recomputed ID", async t => {
  const { root, options, plan } = await fixture(t), { id, ...body } = plan;
  const forged = withId({ ...body, policy: { ...plan.policy, targets: ["@shadcn/used"] } });
  await assert.rejects(applyCleanupPlan(forged, options), { code: "PLAN_STALE" });
  assert.deepEqual(readFileSync(join(root, "ui/used.tsx")), componentBytes); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("a parent replaced with a junction after revalidation cannot redirect deletion or recovery", async t => {
  const { root, options, plan } = await fixture(t), outside = createProject(t, { "unused.tsx": "external source", "used.tsx": "external used" });
  let replaced = false;
  const result = await applyCleanupPlan(plan, { ...options, onProgress(event) {
    if (event.stage !== "application" || event.state !== "start" || replaced) return;
    replaced = true;
    const original = join(root, "ui"), moved = join(root, "ui-original");
    assert.ok(original.startsWith(root + "/") || original.startsWith(root + "\\")); assert.ok(moved.startsWith(root + "/") || moved.startsWith(root + "\\"));
    renameSync(original, moved); symlinkSync(outside, original, process.platform === "win32" ? "junction" : "dir");
  } });
  assert.equal(result.status, "recovery-required", JSON.stringify(result));
  assert.equal(readFileSync(join(outside, "unused.tsx"), "utf8"), "external source");
  assert.deepEqual(readFileSync(join(root, "ui-original/unused.tsx")), componentBytes);
});

test("a cancellation exception after deletion cannot bypass automatic recovery", async t => {
  const { root, options, plan } = await fixture(t); let cancelled = false;
  const result = await applyCleanupPlan(plan, { ...options, onProgress(event) {
    if (!cancelled && event.stage === "application" && event.state === "complete") { cancelled = true; throw new CommandCancelled(); }
  } });
  assert.equal(result.status, "rolled-back", JSON.stringify(result)); assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes);
});

test("verification may update known build caches but never treats new source as generated", async t => {
  const { root, options, plan } = await fixture(t, { scripts: { typecheck: "node verify.cjs" }, extra: { "verify.cjs": 'require("node:fs").writeFileSync("tsconfig.tsbuildinfo","cache");require("node:fs").writeFileSync(".eslintcache","cache");' } });
  const result = await applyCleanupPlan(plan, { ...options, precheck: true });
  assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(readFileSync(join(root, "tsconfig.tsbuildinfo"), "utf8"), "cache");
  await restoreCleanupOperation(result.operationId, options);
  writeFileSync(join(root, "verify.cjs"), 'require("node:fs").writeFileSync("src/generated.ts", "export const Generated=1;");');
  const next = await createCleanupPlan({ ...options, mode: "remove", targets: ["@company/unused"], includeUnverified: true });
  const failed = await applyCleanupPlan(next, options);
  assert.equal(failed.status, "rolled-back", JSON.stringify(failed)); assert.ok(failed.diagnostics.some(d => d.code === "CLEANUP_SCOPE_CHANGED"));
  assert.deepEqual(readFileSync(join(root, "ui/unused.tsx")), componentBytes); assert.equal(readFileSync(join(root, "src/generated.ts"), "utf8"), "export const Generated=1;");
});
