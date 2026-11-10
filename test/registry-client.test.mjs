import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RegistrySource, loadRegistrySources } from "../dist/registry/source.js";
import { RegistryClient, mapLimit } from "../dist/registry/client.js";
import { getRegistriesConfig, getRegistry } from "shadcn/registry";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const button = { name: "button", type: "registry:ui", files: [{ path: "ui/button.tsx", type: "registry:ui", content: "export {};" }] };
const source = (root, url, extra = {}, env = {}) => new RegistrySource("@fixture", { url: `${url}/{name}.json`, ...extra }, root, join(root, "components.json"), "new-york", env);

test("configuration precedence matches the pinned public upstream API", async (t) => {
  const root = createProject(t, {
    "package.json": JSON.stringify({ registries: { "@package": "https://package.example/{name}", "@both": "https://package.example/{name}" } }),
    "components.json": JSON.stringify({ registries: { "@component": "https://component.example/{name}", "@both": "https://component.example/{name}" } }),
  });
  const upstream = await getRegistriesConfig(root, { useCache: false });
  const loaded = loadRegistrySources(root, {});
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.sources.map(({ descriptor }) => descriptor.namespace).sort(), Object.keys(upstream.registries).sort());
  assert.equal(loaded.sources.find(({ descriptor }) => descriptor.namespace === "@both").request("button").url.origin, "https://component.example");
});

test("package.json-only registries work and broken entries do not hide healthy namespaces", (t) => {
  const root = createProject(t, { "package.json": JSON.stringify({ registries: { "@valid": "https://example.test/{name}", "@bad": { url: 4 }, invalid: "https://example.test/{name}" } }) });
  const loaded = loadRegistrySources(root, {});
  assert.deepEqual(loaded.sources.map(({ descriptor }) => descriptor.namespace), ["@shadcn", "@valid"]);
  assert.equal(loaded.diagnostics.length, 2);
});

test("malformed components configuration cannot silently fetch package fallbacks", (t) => {
  const root = createProject(t, { "package.json": '{"registries":{"@private":"https://example.test/{name}"}}', "components.json": "{" });
  assert.equal(loadRegistrySources(root).sources.length, 0);
});

test("templates expand style, env, headers and params without exposing credentials", (t) => {
  const root = createProject(t);
  const entry = new RegistrySource("@private", { url: "https://example.test/{style}/{name}.json?token=${TOKEN}", headers: { Authorization: "Bearer ${TOKEN}" }, params: { version: "${VERSION}" } }, root, "components.json", "base-nova", { TOKEN: "private-token", VERSION: "version-secret" });
  const request = entry.request("login/form");
  assert.equal(request.url.pathname, "/base-nova/login/form.json");
  assert.equal(request.url.searchParams.get("token"), "private-token");
  assert.equal(request.url.searchParams.get("version"), "version-secret");
  assert.equal(request.headers.get("authorization"), "Bearer private-token");
  assert.equal(JSON.stringify(entry).includes("private-token"), false);
  assert.equal(JSON.stringify(entry).includes("version-secret"), false);
  assert.throws(() => new RegistrySource("@missing", { url: "https://example.test/{name}?token=${MISSING}" }, root, "config", "style", {}), { code: "REGISTRY_ENV_MISSING" });
});

test("public cache keys can deduplicate aliases while private credentials and scopes stay isolated", (t) => {
  const root = createProject(t);
  const publicA = source(root, "https://example.test");
  const publicB = source(root + "-other", "https://example.test");
  assert.equal(publicA.request("registry").key, publicB.request("registry").key);
  const privateA = source(root, "https://example.test", { headers: { Authorization: "Bearer one-token" } });
  const privateB = source(root, "https://example.test", { headers: { Authorization: "Bearer two-token" } });
  const privateC = source(root + "-other", "https://example.test", { headers: { Authorization: "Bearer one-token" } });
  assert.notEqual(privateA.request("registry").key, privateB.request("registry").key);
  assert.notEqual(privateA.request("registry").key, privateC.request("registry").key);
});

test("catalog endpoint convention agrees with the public upstream API", async (t) => {
  const server = await registryServer(t, (_req, res) => json(res, catalog([button])));
  const upstream = await getRegistry("@fixture", { config: { registries: { "@fixture": `${server.url}/{name}.json` } }, useCache: false });
  assert.equal(upstream.items[0].name, "button");
  assert.equal(server.requests[0].path, "/registry.json");
});

test("Tailwind v4 new-york style normalization agrees with the public upstream API", async (t) => {
  const server = await registryServer(t, (_req, res) => json(res, catalog([])));
  const root = createProject(t, {
    "package.json": "{}", "components.json": JSON.stringify({ style: "new-york", tailwind: { config: "" }, registries: { "@shadcn": `${server.url}/{style}/{name}.json` } }),
  });
  await getRegistry("@shadcn", { config: { style: "new-york", tailwind: { config: "" }, registries: { "@shadcn": `${server.url}/{style}/{name}.json` } }, useCache: false });
  const own = loadRegistrySources(root, {}).sources[0].request("registry");
  assert.equal(own.url.pathname, server.requests[0].path);
  assert.equal(own.url.pathname, "/new-york-v4/registry.json");
});

test("catalog pagination fetches every page and rejects non-advancing responses", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (req, res) => {
    const offset = Number(new URL(req.url, "http://local").searchParams.get("offset"));
    json(res, catalog([{ name: `item-${offset}`, type: "registry:ui" }], { total: 3, offset, limit: 1, hasMore: offset < 2 }));
  });
  const result = await new RegistryClient({ cacheDir: false }).catalog(source(root, server.url));
  assert.equal(result.status, "ready");
  assert.equal(result.items.length, 3);
  assert.equal(result.pages, 3);
  const broken = await registryServer(t, (_req, res) => json(res, catalog([button], { total: 2, offset: 0, limit: 0, hasMore: true })));
  assert.equal((await new RegistryClient({ cacheDir: false }).catalog(source(root, broken.url))).status, "error");
});

test("cache revalidation uses ETags; stored metadata omits source code and credentials", async (t) => {
  const root = createProject(t);
  const cacheDir = join(root, "cache");
  const server = await registryServer(t, (req, res) => {
    if (req.headers["if-none-match"] === '"first"') { res.writeHead(304); res.end(); return; }
    json(res, catalog([{ ...button, description: "private-token", registryDependencies: ["https://dependency.test/button?token=private-token"] }]), { etag: '"first"' });
  });
  const entry = source(root, server.url, { headers: { Authorization: "Bearer private-token" } });
  const first = await new RegistryClient({ cacheDir }).fetch(entry, "registry", "catalog");
  const cached = await new RegistryClient({ cacheDir }).fetch(entry, "registry", "catalog");
  const refreshed = await new RegistryClient({ cacheDir, refresh: true }).fetch(entry, "registry", "catalog");
  assert.equal(first.cache, "network");
  assert.equal(cached.cache, "fresh-cache");
  assert.equal(refreshed.cache, "revalidated");
  assert.equal(server.requests.length, 2);
  assert.equal(cached.document.items[0].files[0].contentHash, first.document.items[0].files[0].contentHash);
  assert.equal(cached.document.items[0].registryDependencies[0].reference, "https://dependency.test/button");
  const stored = readdirSync(cacheDir).map((name) => readFileSync(join(cacheDir, name), "utf8")).join("");
  assert.equal(stored.includes("private-token"), false);
  assert.equal(stored.includes("export {};"), false);
});

test("offline cache misses and changed credentials cannot reuse another context", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (_req, res) => json(res, catalog([button])));
  const cacheDir = join(root, "cache");
  await new RegistryClient({ cacheDir }).fetch(source(root, server.url, { headers: { authorization: "first-token" } }), "registry", "catalog");
  await assert.rejects(new RegistryClient({ cacheDir, offline: true }).fetch(source(root, server.url, { headers: { authorization: "second-token" } }), "registry", "catalog"), { code: "REGISTRY_CACHE_MISS" });
  assert.equal(server.requests.length, 1);
});

test("failed refresh preserves cached metadata as stale and marks the source incomplete", async (t) => {
  const root = createProject(t);
  let fail = false;
  const server = await registryServer(t, (_req, res) => { if (fail) { res.writeHead(401); res.end(); } else json(res, catalog([button])); });
  const cacheDir = join(root, "cache");
  const entry = source(root, server.url);
  await new RegistryClient({ cacheDir }).catalog(entry);
  fail = true;
  const result = await new RegistryClient({ cacheDir, refresh: true }).catalog(entry);
  assert.equal(result.status, "stale");
  assert.equal(result.items.length, 1);
  assert.equal(result.diagnostics[0].code, "REGISTRY_UNAUTHORIZED");
});

test("expired offline metadata remains available with explicit stale coverage", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (_req, res) => json(res, catalog([button])));
  const cacheDir = join(root, "cache");
  const entry = source(root, server.url);
  await new RegistryClient({ cacheDir }).catalog(entry);
  const result = await new RegistryClient({ cacheDir, offline: true, ttlMs: 0 }).catalog(entry);
  assert.equal(result.status, "stale");
  assert.equal(result.items.length, 1);
  assert.equal(result.diagnostics[0].code, "REGISTRY_CACHE_STALE");
  assert.equal(server.requests.length, 1);
});

test("damaged caches are misses and never produce invented catalog data", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (_req, res) => json(res, catalog([button])));
  const cacheDir = join(root, "cache");
  const entry = source(root, server.url);
  await new RegistryClient({ cacheDir }).fetch(entry, "registry", "catalog");
  writeFileSync(join(cacheDir, readdirSync(cacheDir)[0]), "{");
  await assert.rejects(new RegistryClient({ cacheDir, offline: true }).fetch(entry, "registry", "catalog"), { code: "REGISTRY_CACHE_MISS" });
});

test("in-flight requests are deduplicated and concurrency is bounded", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (_req, res) => json(res, catalog([button])));
  const entry = source(root, server.url);
  const client = new RegistryClient({ cacheDir: false });
  await Promise.all([client.fetch(entry, "registry", "catalog"), client.fetch(entry, "registry", "catalog")]);
  await client.fetch(entry, "registry", "catalog");
  assert.equal(server.requests.length, 1);
  let running = 0; let maximum = 0;
  const values = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    running++; maximum = Math.max(maximum, running);
    await new Promise((resolve) => setTimeout(resolve, 5)); running--; return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
});

test("normalized font catalogs and detailed content hashes survive offline cache reads", async (t) => {
  const root = createProject(t);
  const font = { name: "font-inter", type: "registry:font", font: { family: "Inter", provider: "google", import: "Inter", variable: "--font-inter" } };
  const server = await registryServer(t, (req, res) => json(res, req.url.includes("registry.json") ? catalog([font]) : button));
  const cacheDir = join(root, "cache");
  const entry = source(root, server.url);
  const online = new RegistryClient({ cacheDir });
  await online.fetch(entry, "registry", "catalog");
  const detail = await online.fetch(entry, "button", "item");
  assert.match(detail.document.items[0].files[0].contentHash, /^[a-f0-9]{64}$/);
  const offline = new RegistryClient({ cacheDir, offline: true });
  assert.equal((await offline.fetch(entry, "registry", "catalog")).document.items[0].type, "registry:font");
  assert.equal((await offline.fetch(entry, "button", "item")).document.items[0].files[0].contentHash, detail.document.items[0].files[0].contentHash);
  assert.equal(server.requests.length, 2);
});

test("pagination cannot claim complete coverage while omitting catalog records", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (_req, res) => json(res, catalog([button], { total: 4, offset: 0, limit: 100, hasMore: false })));
  const result = await new RegistryClient({ cacheDir: false }).catalog(source(root, server.url));
  assert.equal(result.status, "error");
  assert.equal(result.items.length, 1);
  assert.equal(result.diagnostics[0].code, "REGISTRY_PAGINATION_INVALID");
});

test("cross-origin redirects never forward configured authorization", async (t) => {
  const root = createProject(t);
  const other = await registryServer(t, (_req, res) => json(res, catalog([])));
  const server = await registryServer(t, (_req, res) => { res.writeHead(302, { location: other.url }); res.end(); });
  await assert.rejects(new RegistryClient({ cacheDir: false }).fetch(source(root, server.url, { headers: { authorization: "secret-token" } }), "registry", "catalog"), { code: "REGISTRY_REDIRECT_BLOCKED" });
  assert.equal(other.requests.length, 0);
});

test("rate limits retry briefly but do not ignore a long Retry-After", async (t) => {
  const root = createProject(t);
  const server = await registryServer(t, (_req, res, count) => { if (count === 1) { res.writeHead(429, { "retry-after": "0" }); res.end(); } else json(res, catalog([])); });
  assert.equal((await new RegistryClient({ cacheDir: false }).catalog(source(root, server.url))).status, "ready");
  assert.equal(server.requests.length, 2);
  const long = await registryServer(t, (_req, res) => { res.writeHead(429, { "retry-after": "60" }); res.end(); });
  await new RegistryClient({ cacheDir: false }).catalog(source(root, long.url));
  assert.equal(long.requests.length, 1);
});

test("oversized, invalid JSON and unresolved include catalogs fail explicitly", async (t) => {
  const root = createProject(t);
  for (const [payload, code, maxBytes] of [["x".repeat(100), "REGISTRY_RESPONSE_TOO_LARGE", 20], ["{", "REGISTRY_RESPONSE_INVALID", 1000], [JSON.stringify({ ...catalog([]), include: ["./ui/registry.json"] }), "REGISTRY_SCHEMA_INVALID", 1000]]) {
    const server = await registryServer(t, (_req, res) => res.end(payload));
    await assert.rejects(new RegistryClient({ cacheDir: false, maxBytes }).fetch(source(root, server.url), "registry", "catalog"), { code });
  }
});

test("timeouts, cancellation, and catalog-less registries remain explicit", async (t) => {
  const root = createProject(t);
  const slow = await registryServer(t, () => {});
  await assert.rejects(new RegistryClient({ cacheDir: false, timeoutMs: 15 }).fetch(source(root, slow.url), "registry", "catalog"), { code: "REGISTRY_FETCH_FAILED" });
  const signal = AbortSignal.abort();
  await assert.rejects(new RegistryClient({ cacheDir: false, signal }).fetch(source(root, slow.url), "registry", "catalog"), { code: "REGISTRY_CANCELLED" });
  const absent = await registryServer(t, (_req, res) => { res.writeHead(404); res.end(); });
  assert.equal((await new RegistryClient({ cacheDir: false }).catalog(source(root, absent.url))).status, "catalog-unavailable");
});
