import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { parseCheckBaseline, parseCheckPolicy } from "../dist/check/model.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const execute = promisify(execFile), cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const blocker = new URL("../fixtures/cli/register-block-workflows.mjs", import.meta.url).href;
const analysisBlocker = new URL("../fixtures/cli/register-block-analysis.mjs", import.meta.url).href;
const source = "export const Value=1;\n";
async function fixture(t, workspace = false) {
  const state = { hold: false, requested: () => {} };
  const server = await registryServer(t, (req, res) => {
    if (state.hold) { state.requested(); return; }
    const path = new URL(req.url, "http://local").pathname, custom = path.startsWith("/private/");
    if (custom && req.headers.authorization !== "Bearer check-private-secret") { res.writeHead(401); return res.end(); }
    const items = (custom ? ["unused", "extra"] : ["used"]).map(name => ({ name, type: "registry:ui", files: [{ path: `ui/${name}.tsx`, type: "registry:ui", content: source }] }));
    const name = path.split("/").at(-1).replace(/\.json$/, ""), value = name === "registry" ? catalog(items) : items.find(item => item.name === name);
    if (value) return json(res, value); res.writeHead(404); res.end();
  });
  const appFiles = { "package.json": '{"name":"@example/web","dependencies":{"vite":"7","react":"19"}}',
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/official/{name}.json`, "@company": { url: `${server.url}/private/{name}.json`, headers: { Authorization: "Bearer ${CHECK_REGISTRY_TOKEN}" } } } }, null, 2),
    "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"~/*":["./*"]}}}',
    "index.html": '<script type="module" src="/src/main.tsx"></script>', "src/main.tsx": 'import {Value} from "../ui/used";console.log(Value);', "ui/used.tsx": source, "ui/unused.tsx": source,
  };
  const files = workspace ? { "package.json": '{"workspaces":["apps/*"]}', ...Object.fromEntries(Object.entries(appFiles).map(([path, value]) => [`apps/web/${path}`, value])),
    "apps/consumer/package.json": '{"name":"@example/consumer","dependencies":{"react":"19"}}', "apps/consumer/src/main.tsx": 'console.log("consumer");' } : appFiles;
  const root = createProject(t, files), cwd = workspace ? join(root, "apps/web") : root;
  return { root, cwd, files, server, state, env: { ...process.env, CHECK_REGISTRY_TOKEN: "check-private-secret", NO_COLOR: "1" } };
}
async function run(cwd, args, env, imports = [blocker]) {
  const settings = { ...env }; delete settings.FORCE_COLOR;
  try { return { ...await execute(process.execPath, [...imports.flatMap(path => ["--import", path]), cli, ...args], { cwd, env: settings, encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024 }), status: 0 }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
}
function snapshot(root) { return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => { const path = join(entry.parentPath, entry.name); return [relative(root, path), readFileSync(path, "base64")]; })); }

test("check uses complete read-only audit results with bounded output and policy exit codes", async t => {
  const { root, cwd, env } = await fixture(t), before = snapshot(root);
  const failed = await run(cwd, ["check", "--json", "--no-cache", "--limit", "0"], env);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr); assert.equal(failed.stderr, "");
  const report = JSON.parse(failed.stdout).error.details.check;
  assert.equal(report.complete, true); assert.equal(report.counts.newErrors, 1); assert.equal(report.findings.length, 0); assert.ok(report.omittedFindings >= 1);
  assert.doesNotMatch(failed.stdout, /check-private-secret|projectRoot|proof/); assert.deepEqual(snapshot(root), before);
  const policy = join(root, "policy.json"); writeFileSync(policy, JSON.stringify({ policyVersion: 1, rules: { "unused-item": "warning", "unused-file": "warning" } }));
  const passed = await run(cwd, ["check", "--policy", policy, "--json", "--no-cache"], env);
  assert.equal(passed.status, 0, passed.stdout); assert.equal(JSON.parse(passed.stdout).data.check.counts.newErrors, 0);
});

test("reviewed baselines survive workspace relocation and detect new findings and changed policy", async t => {
  const { root, cwd, files, env } = await fixture(t, true), baseline = join(root, ".shadcn-plus/check-baseline.json");
  const captured = await run(root, ["check", "--cwd", cwd, "--no-cache", "baseline", "--out", baseline, "--json"], env);
  assert.equal(captured.status, 0, captured.stdout + captured.stderr);
  const artifact = parseCheckBaseline(readFileSync(baseline, "utf8")); assert.equal(artifact.project.selected, "apps/web"); assert.ok(artifact.entries.length > 0);
  assert.throws(() => parseCheckBaseline({ ...artifact, id: "0".repeat(64) }), { code: "CHECK_BASELINE_INVALID" });
  assert.doesNotMatch(JSON.stringify(artifact), /check-private-secret|shadcn-plus-test-/);
  const copy = createProject(t, Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content.replace(/\r?\n/g, "\r\n")]))), copiedApp = join(copy, "apps/web");
  const accepted = await run(copy, ["check", "--cwd", copiedApp, "--baseline", baseline, "--json", "--summary", "--no-cache"], env);
  assert.equal(accepted.status, 0, accepted.stdout); assert.ok(JSON.parse(accepted.stdout).data.check.baseline.accepted >= 1);
  writeFileSync(join(copiedApp, "ui/extra.tsx"), source);
  const newIssue = await run(copy, ["check", "--cwd", copiedApp, "--baseline", baseline, "--json", "--limit", "0", "--no-cache"], env);
  assert.equal(newIssue.status, 1, newIssue.stdout); assert.equal(JSON.parse(newIssue.stdout).error.details.check.counts.newErrors, 1);
  const policy = join(copy, "new-policy.json"); writeFileSync(policy, '{"policyVersion":1,"rules":{"unused-item":"warning"}}');
  const incompatible = await run(copy, ["check", "--cwd", copiedApp, "--baseline", baseline, "--policy", policy, "--json", "--no-cache"], env);
  assert.equal(incompatible.status, 2); assert.ok(JSON.parse(incompatible.stdout).error.details.check.diagnostics.some(entry => entry.code === "CHECK_BASELINE_CONTEXT_CHANGED"));
});

test("disabled rules cannot waive incomplete coverage or a cancelled CI run", async t => {
  const { root, cwd, env, state } = await fixture(t), policy = join(root, "policy.json"), output = join(root, ".shadcn-plus/invalid-baseline.json");
  writeFileSync(policy, JSON.stringify({ policyVersion: 1, rules: { "unused-item": "off", "unused-file": "off", "unused-package": "off", "unknown-usage": "off" } }));
  writeFileSync(join(cwd, "src/dynamic.ts"), "import(process.env.COMPONENT);");
  const partial = await run(cwd, ["check", "--policy", policy, "--json", "--no-cache"], env);
  assert.equal(partial.status, 2, partial.stdout); assert.equal(JSON.parse(partial.stdout).error.code, "CHECK_INCOMPLETE");
  const capture = await run(cwd, ["check", "baseline", "--out", output, "--policy", policy, "--json", "--no-cache"], env);
  assert.equal(capture.status, 2); assert.equal(existsSync(output), false);
  assert.throws(() => parseCheckPolicy({ policyVersion: 1, rules: { unknown: "off" } }), { code: "CHECK_POLICY_INVALID" });
  state.hold = true; const requested = new Promise(resolve => { state.requested = resolve; });
  const child = fork(fileURLToPath(new URL("../fixtures/cli/cancellable-command.mjs", import.meta.url)), ["check", "--json", "--no-cache"], { cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await Promise.race([requested, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("No check request")), 10000); timer.unref(); })]);
  child.send("cancel"); assert.equal(await exited, 2, stdout + stderr); assert.equal(JSON.parse(stdout).error.code, "CHECK_INTERRUPTED");
});

test("portable skill installs explicitly, keeps discovery lazy, and its used-component workflow refuses deletion", async t => {
  const { root, cwd, env } = await fixture(t), instructions = join(root, "AGENTS.md"); writeFileSync(instructions, "existing instructions");
  const shown = await run(cwd, ["agent", "skill", "--json"], env, [blocker, analysisBlocker]);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const skill = JSON.parse(shown.stdout).data.skill, metadata = parseYaml(skill.content.match(/^---\r?\n([\s\S]+?)\r?\n---/)[1]); assert.equal(metadata.name, "shadcn-plus");
  const destination = join(root, ".agents/skills/shadcn-plus");
  const installed = await run(cwd, ["agent", "skill", "--out", destination, "--json"], env); assert.equal(installed.status, 0, installed.stdout);
  assert.equal(readFileSync(join(destination, "SKILL.md"), "utf8"), skill.content);
  assert.equal((await run(cwd, ["agent", "skill", "--out", destination, "--json"], env)).status, 2); assert.equal(readFileSync(instructions, "utf8"), "existing instructions");
  for (const args of [["check", "--help"], ["check", "baseline", "--help"], ["agent", "skill", "--help"]]) assert.equal((await run(cwd, ["--json", ...args], env, [blocker, analysisBlocker])).status, 0);
  const why = await run(cwd, ["why", "@shadcn/used", "--json", "--no-cache"], env); assert.equal(why.status, 0, why.stdout); assert.equal(JSON.parse(why.stdout).data.target.finding.usage, "runtime");
  const refused = await run(cwd, ["plan", "remove", "@shadcn/used", "--include-unverified", "--json", "--summary", "--no-cache"], env);
  assert.equal(refused.status, 2); const plan = JSON.parse(refused.stdout).error.details.plan; assert.equal(plan.counts.files, 0); assert.ok(plan.excluded.some(entry => entry.reasons.includes("USAGE_RETAINED")));
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const imported = await execute(process.execPath, ["--import", blocker, "--import", analysisBlocker, "--input-type=module", "--eval", `const api=await import(${JSON.stringify(entry)});for(const key of ['checkProject','createCheckBaseline','getAgentSkill'])if(typeof api[key]!=='function')throw Error(key);console.log('lazy');`], { cwd, env, encoding: "utf8", timeout: 10000 }); assert.equal(imported.stdout, "lazy\n");
});
