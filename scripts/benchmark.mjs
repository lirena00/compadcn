import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execa } from "execa";
import { auditProject, buildInventory, buildDependencyGraph, createCleanupPlan } from "../dist/index.js";
import { catalogEntries, createCatalogIndex } from "../dist/catalog/model.js";
import { summarizeAudit } from "../dist/cli/audit.js";

const root = await mkdtemp(join(tmpdir(), "shadcn-plus-benchmark-")), cwd = join(root, "project");
await mkdir(join(cwd, "ui"), { recursive: true });
let failing = false, requests = 0;
const shared = "export const value = 1;\n", dead = 'import { value } from "../shared";\nexport const unused = value;\n';
const names = ["@shadcn", ...Array.from({ length: 19 }, (_, i) => `@r${i + 1}`)];
const items = names.map((namespace, i) => [
  { name: i ? "dead" : "shared", type: "registry:ui", ...(i ? { registryDependencies: ["@shadcn/shared", ...(i === 1 ? ["@r2/dead"] : i === 2 ? ["@r1/dead"] : [])] } : {}), files: [{ path: i ? `ui/r${i}/dead.tsx` : "ui/shared.tsx", target: i ? `@ui/r${i}/dead.tsx` : "@ui/shared.tsx", type: "registry:ui", content: i ? dead : shared }] },
  { name: "available", type: "registry:ui", files: [{ path: "available.tsx", target: `@ui/r${i}/available.tsx`, type: "registry:ui", content: "export const available = 1;\n" }] },
]);
const server = createServer((req, res) => {
  requests++;
  const url = new URL(req.url, "http://fixture"), [, key, filename] = url.pathname.split("/"), i = Number(key), name = filename?.replace(/\.json$/, "");
  if (i === 19 && req.headers.authorization !== "Bearer benchmark-fixture-token") { res.writeHead(401); return res.end(); }
  if (failing && i === 19) return; // Real request timeout; no fabricated error object.
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const value = name === "registry" ? { name: "fixture", homepage: "https://fixture.example", items: items[i].slice(offset, offset + 1), pagination: { total: 2, offset, limit: 1, hasMore: offset < 1 } } : items[i]?.find(item => item.name === name);
  res.writeHead(value ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(value ?? {}));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const registries = Object.fromEntries(names.map((namespace, i) => [namespace, { url: `http://127.0.0.1:${server.address().port}/${i}/{name}.json`, ...(i === 19 ? { headers: { Authorization: "Bearer ${BENCHMARK_REGISTRY_TOKEN}" } } : {}) }]));
const env = { ...process.env, BENCHMARK_REGISTRY_TOKEN: "benchmark-fixture-token" };
await writeFile(join(cwd, ".git"), "");
await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { vite: "7", react: "19" } }));
await writeFile(join(cwd, "components.json"), JSON.stringify({ aliases: { ui: "./ui" }, registries }));
await writeFile(join(cwd, "index.html"), '<script type="module" src="/main.tsx"></script>');
await writeFile(join(cwd, "main.tsx"), 'import { value } from "./ui/shared";\nconsole.log(value);\n');
await writeFile(join(cwd, "ui/shared.tsx"), shared);
for (let i = 1; i < 20; i++) { await mkdir(join(cwd, `ui/r${i}`)); await writeFile(join(cwd, `ui/r${i}/dead.tsx`), dead); }
const options = { cwd, env, cacheDir: join(root, "cache"), timeoutMs: 1000 };
const timed = async action => { const started = performance.now(), value = await action(); return { value, ms: +(performance.now() - started).toFixed(2) }; };
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
try {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url)), startup = {};
  for (const flag of ["--help", "--version"]) {
    const samples = [];
    for (let i = 0; i < 7; i++) samples.push((await timed(() => execa(process.execPath, [cli, flag]))).ms);
    startup[flag] = { medianMs: median(samples), samplesMs: samples };
  }
  const cold = await timed(() => buildInventory(options)), coldRequests = requests;
  const warm = await timed(() => buildInventory(options)), warmRequests = requests - coldRequests;
  assert.equal(cold.value.complete, true, JSON.stringify(cold.value.diagnostics));
  assert.equal(cold.value.counts.sources, 20);
  assert.equal(cold.value.items.filter(item => item.presence === "absent").length, 20);
  assert.equal(cold.value.items.filter(item => item.presence === "present").length, 20);
  assert.equal(warmRequests, 0);
  const graph = await buildDependencyGraph(options);
  assert.equal(graph.complete, true, JSON.stringify(graph.diagnostics));
  assert.ok(graph.cycles.some(({ kind }) => kind === "registry"));
  const audit = await timed(() => auditProject(options));
  assert.equal(audit.value.complete, true, JSON.stringify(audit.value.diagnostics));
  assert.equal(audit.value.items.filter(item => item.usage === "unused-candidate").length, 19);
  const entries = catalogEntries(cold.value);
  const synthetic = Array.from({ length: 10000 }, (_, i) => ({ ...entries[i % entries.length], id: `synthetic-${i}`, address: `@r${i % 20}/button-${i}` }));
  const index = createCatalogIndex(synthetic), querySamples = [];
  for (let i = 0; i < 1000; i++) { const started = performance.now(); index.search(`button-${i % 100}`); querySamples.push(performance.now() - started); }
  const fullBytes = Buffer.byteLength(JSON.stringify(audit.value)), summaryBytes = Buffer.byteLength(JSON.stringify(summarizeAudit(audit.value)));
  failing = true;
  const incomplete = await auditProject({ ...options, cacheDir: false, timeoutMs: 50 });
  assert.equal(incomplete.complete, false);
  const blocked = await createCleanupPlan({ ...options, cacheDir: false, timeoutMs: 50, mode: "remove", targets: ["@r1/dead"], includeUnverified: true });
  assert.notEqual(blocked.status, "ready"); assert.equal(blocked.operations.length, 0);
  const report = { node: process.version, platform: process.platform, architecture: process.arch, startup,
    registries: { count: 20, catalogPages: 40, coldMs: cold.ms, coldRequests, warmMs: warm.ms, warmRequests, auditMs: audit.ms, availableItems: 20, presentCandidates: 20, unusedCandidates: 19, crossRegistryCycle: true, timeoutBlocksCleanup: true, authenticatedSource: true },
    indexedSearch: { syntheticEntries: 10000, queries: 1000, medianMs: +median(querySamples).toFixed(3), p95Ms: +querySamples.sort((a,b)=>a-b)[949].toFixed(3) },
    output: { fullJSONBytes: fullBytes, summaryJSONBytes: summaryBytes, tokenUsage: "not-measured", agentComparison: "not-measured" },
    limits: "Local loopback fixture; timings are machine-specific. Byte counts are not token counts or evidence of agent savings." };
  await writeFile(join(root, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: join(root, "results.json") }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
