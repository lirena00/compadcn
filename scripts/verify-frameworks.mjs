import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execa } from "execa";
import { performance } from "node:perf_hooks";
import { cases, projectFiles } from "../fixtures/release/projects.mjs";
import { discoverProject, auditProject, createOwnershipSnapshot, createCleanupPlan, applyCleanupPlan, restoreCleanupOperation } from "../dist/index.js";

const fixtureDir = fileURLToPath(new URL("../fixtures/release/", import.meta.url));
const manifest = JSON.parse(await readFile(join(fixtureDir, "package.json"), "utf8"));
const root = await mkdtemp(join(tmpdir(), "shadcn-plus-frameworks-"));
const documents = new Map(), token = "local-release-fixture-token";
const server = createServer((req, res) => {
  const parts = new URL(req.url, "http://fixture").pathname.split("/"), doc = documents.get(parts[1]);
  if (parts[2] === "private" && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
  const items = doc?.[parts[2]], name = parts[3]?.replace(/\.json$/, "");
  const value = name === "registry" && items ? { name: "fixture", homepage: "https://fixture.example", items } : items?.find(item => item.name === name);
  res.writeHead(value ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(value ?? {}));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.error(`Framework workspace: ${root}`);
const results = [], env = { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1", RELEASE_REGISTRY_TOKEN: token };
delete env.FORCE_COLOR;
async function command(cwd, bin, args, label) {
  const started = performance.now();
  const result = await execa(bin, args, { cwd, env, reject: false, all: true, timeout: 600000 });
  await writeFile(join(root, `${label}.log`), result.all ?? "");
  assert.equal(result.exitCode, 0, `${label}:\n${result.all?.slice(-8000)}`);
  return Math.round(performance.now() - started);
}
try {
  for (const spec of cases) {
    console.error(`Verifying ${spec.id}: install → build → audit → plan → apply/build → restore`);
    const dependencies = spec.framework === "vite" ? JSON.parse(await readFile(join(fixtureDir, "vite/package.json"), "utf8")) : manifest;
    const cwd = join(root, spec.id), doc = projectFiles(spec, `http://127.0.0.1:${server.address().port}`, dependencies);
    documents.set(spec.id, doc);
    for (const [path, content] of Object.entries(doc.files)) { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), content); }
    const lock = spec.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
    await copyFile(join(fixtureDir, spec.framework === "vite" ? "vite" : "", lock), join(cwd, lock));
    await command(cwd, spec.manager, spec.manager === "npm" ? ["ci", "--no-audit", "--no-fund"] : ["install", "--frozen-lockfile"], `${spec.id}-install`);
    const baselineBuildMs = await command(cwd, spec.manager, ["run", "build"], `${spec.id}-baseline`);
    const options = { cwd, env, cacheDir: false, ...(spec.framework === "vite" ? { entries: ["src/main.jsx"] } : {}) };
    assert.equal((await discoverProject({ cwd, env })).framework, spec.framework === "vite" ? "vite-react" : "next");
    const audit = await auditProject(options);
    await writeFile(join(root, `${spec.id}-audit.json`), JSON.stringify(audit, null, 2));
    assert.equal(audit.complete, true, JSON.stringify(audit.diagnostics));
    assert.equal(audit.items.find(item => item.addresses.includes("@private/dead"))?.usage, "unused-candidate");
    assert.equal(audit.items.find(item => item.addresses.includes("@shadcn/live"))?.usage, "runtime");
    const ownership = await createOwnershipSnapshot(options);
    assert.equal(ownership.complete, true, JSON.stringify(ownership.diagnostics));
    // This fixed corpus is its ownership-review ground truth; ordinary users
    // must review an observed snapshot before adopting it.
    const plan = await createCleanupPlan({ ...options, ownership, verificationScripts: spec.tsx ? ["typecheck", "build"] : ["build"] });
    await writeFile(join(root, `${spec.id}-plan.json`), JSON.stringify(plan, null, 2));
    assert.equal(plan.status, "ready", JSON.stringify({ diagnostics: plan.diagnostics, excluded: plan.excluded }));
    const deadPath = `${spec.ui}/dead.${spec.tsx ? "tsx" : "jsx"}`;
    assert.deepEqual(plan.operations.map(({ path }) => path), [deadPath]);
    const protectedPaths = ["package.json", lock, "components.json", "styles.css", `${spec.ui}/shared.${spec.tsx ? "ts" : "js"}`, `${spec.ui}/live.${spec.tsx ? "tsx" : "jsx"}`];
    const before = await Promise.all(protectedPaths.map(path => readFile(join(cwd, path))));
    const receipt = await applyCleanupPlan(plan, { cwd, env, verificationTimeoutMs: 300000 });
    await writeFile(join(root, `${spec.id}-receipt.json`), JSON.stringify(receipt, null, 2));
    assert.equal(receipt.status, "completed", JSON.stringify(receipt));
    assert.equal(existsSync(join(cwd, deadPath)), false);
    assert.ok(receipt.verification.every(({ status }) => status === "passed"));
    for (const [index, path] of protectedPaths.entries()) assert.deepEqual(await readFile(join(cwd, path)), before[index], `Protected input changed: ${path}`);
    const restored = await restoreCleanupOperation(receipt.operationId, { cwd });
    assert.equal(restored.status, "restored");
    assert.equal(await readFile(join(cwd, deadPath), "utf8"), doc.files[deadPath]);
    results.push({ ...spec, baselineBuildMs, verification: receipt.verification, exactDeletion: deadPath, restored: true });
  }
  const report = { node: process.version, platform: process.platform, results };
  await writeFile(join(root, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: join(root, "results.json") }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
