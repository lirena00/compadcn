import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCollection, parseCollection } from "../dist/collections/model.js";
import { listCollections, readCollection, writeCollection } from "../dist/collections/files.js";
import { migrateLegacyPresets } from "../dist/collections/migrate.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";
import { stubPackageManagers } from "../fixtures/cli/package-manager-stubs.mjs";

const execute = promisify(execFile), cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const blocker = new URL("../fixtures/cli/register-block-workflows.mjs", import.meta.url).href;
const analysisBlocker = new URL("../fixtures/cli/register-block-analysis.mjs", import.meta.url).href;
const content = "export const Value=1;";
const item = (name, custom) => ({ name, type: "registry:ui", files: [{ path: `ui/${name}.tsx`, type: "registry:ui", content, ...(custom ? { target: `~/private/${name}.tsx` } : {}) }] });
async function fixture(t) {
  const state = { privateDown: false };
  const server = await registryServer(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname, custom = path.startsWith("/private/");
    if (custom && (state.privateDown || req.headers.authorization !== "Bearer collections-secret")) { res.writeHead(401); return res.end(); }
    const values = (custom ? ["button", "widget"] : ["button", "card"]).map(name => item(name, custom)), name = path.split("/").at(-1).replace(/\.json$/, "");
    const value = name === "registry" ? catalog(values) : values.find(value => value.name === name);
    if (value) return json(res, value); res.writeHead(404); res.end();
  });
  const root = createProject(t, { "package.json": '{"packageManager":"npm@10.0.0"}', "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: {
    "@shadcn": `${server.url}/official/{name}.json`, "@alias": `${server.url}/official/{name}.json`,
    "@company": { url: `${server.url}/private/{name}.json`, headers: { Authorization: "Bearer ${COLLECTION_TOKEN}" } },
  } }) });
  const env = { ...stubPackageManagers(root), COLLECTION_TOKEN: "collections-secret" };
  return { root, env, server, state, options: { cwd: root, env, cacheDir: false } };
}
async function run(root, args, env, imports = [blocker]) {
  try { return { ...await execute(process.execPath, [...imports.flatMap(value => ["--import", value]), cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024 }), status: 0 }; }
  catch (error) { if (typeof error.code !== "number") throw error; return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
}

test("collection files compose qualified intent, validate their format and never overwrite", async t => {
  const root = createProject(t), base = createCollection({ name: "Base", items: ["button", "@company/button"] });
  const collection = createCollection({ name: "App", description: "Intent", bases: [base], items: ["@shadcn/button", "card"] });
  assert.deepEqual(collection.items, ["@shadcn/button", "@company/button", "@shadcn/card"]);
  assert.throws(() => parseCollection({ ...collection, dependencies: ["copied"] }), { code: "COLLECTION_INVALID" });
  const path = join(root, "collections/app.json"); await writeCollection(collection, path);
  assert.deepEqual(await readCollection(path), collection); assert.equal((await listCollections(join(root, "collections"))).entries[0].items, 3);
  await assert.rejects(writeCollection(base, path), { code: "COLLECTION_OUTPUT_EXISTS" });
  assert.deepEqual(await readCollection(path), collection);
});

test("legacy migration resolves registry identities, blocks ambiguity and writes an exact backup", async t => {
  const { root, options } = await fixture(t), source = join(root, "old.json"), output = join(root, "migrated");
  const bytes = Buffer.from("\uFEFF" + JSON.stringify({ presets: { dashboard: { label: "My Dashboard", description: "First line\nSecond line", components: [
    { label: "Card", value: "card", dependencies: ["copied-metadata"], internal_dependencies: ["old"] }, { value: "button" }, { value: "@company/widget" },
  ] } } }, null, 2)); writeFileSync(source, bytes);
  const blocked = await migrateLegacyPresets({ ...options, source, output });
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.entries[0].issues[0].code, "LEGACY_COMPONENT_AMBIGUOUS");
  assert.equal(blocked.entries[0].collection, undefined); assert.equal(existsSync(output), false);
  const migrated = await migrateLegacyPresets({ ...options, source, output, mappings: { button: "@company/button" } });
  assert.equal(migrated.status, "written"); assert.deepEqual(readFileSync(source), bytes); assert.deepEqual(readFileSync(migrated.backup), bytes);
  const collection = await readCollection(join(output, migrated.entries[0].filename));
  assert.equal(collection.name, "My Dashboard"); assert.equal(collection.description, "First line\nSecond line");
  assert.deepEqual(collection.items, ["@shadcn/card", "@company/button", "@company/widget"]);
  assert.doesNotMatch(JSON.stringify(collection), /copied-metadata|internal_dependencies|collections-secret/);
});

test("migration preserves uncertainty and changed or malformed source data", async t => {
  const { root, options, server, state } = await fixture(t), source = join(root, "old.json"), output = join(root, "out");
  const original = JSON.stringify({ presets: { base: { label: "Base", description: "", components: [{ value: "card" }] } } });
  writeFileSync(source, original); state.privateDown = true;
  const partial = await migrateLegacyPresets({ ...options, source, output }); assert.equal(partial.complete, false);
  assert.equal(partial.entries[0].issues[0].code, "MIGRATION_CATALOG_INCOMPLETE"); assert.equal(existsSync(output), false);
  const requests = server.requests.length;
  assert.equal((await migrateLegacyPresets({ ...options, source, mappings: { card: "@shadcn/card" } })).complete, true);
  assert.equal(server.requests.length, requests);
  state.privateDown = false;
  await assert.rejects(migrateLegacyPresets({ ...options, source, output, onProgress(event) { if (event.stage === "registry" && event.state === "complete") writeFileSync(source, '{"presets":{}}'); } }), { code: "MIGRATION_SOURCE_CHANGED" });
  assert.equal(existsSync(output), false); assert.equal(readFileSync(source, "utf8"), '{"presets":{}}');
  writeFileSync(source, "{broken"); await assert.rejects(migrateLegacyPresets({ ...options, source }), { code: "MIGRATION_SOURCE_INVALID" }); assert.equal(readFileSync(source, "utf8"), "{broken");
});

test("collection CLI creates, composes, lists and explicitly migrates without eager workflows", async t => {
  const { root, env, server } = await fixture(t);
  const created = await run(root, ["collection", "create", "collections/base.json", "button", "@company/widget", "--name", "Base", "--json"], env);
  assert.equal(created.status, 0, created.stdout + created.stderr); assert.equal(JSON.parse(created.stdout).data.collection.items.length, 2);
  const composed = await run(root, ["collection", "create", "collections/app.json", "card", "--from", "collections/base.json", "--json"], env); assert.equal(composed.status, 0, composed.stdout);
  const shown = await run(root, ["collection", "show", "collections/app.json", "--json"], env); assert.equal(JSON.parse(shown.stdout).data.collection.items.length, 3);
  const listed = await run(root, ["collection", "list", "collections", "--json"], env); assert.equal(JSON.parse(listed.stdout).data.collections.entries.length, 2);
  const source = join(root, "old.json"); writeFileSync(source, JSON.stringify({ presets: { favourite: { label: "My picks", description: "", components: [{ value: "old-widget" }] }, invalid: null } }));
  const blocked = await run(root, ["collection", "migrate", "--from", source, "--map", "old-widget=@company/widget", "--out", "blocked", "--json"], env);
  assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).error.code, "MIGRATION_BLOCKED"); assert.equal(existsSync(join(root, "blocked")), false);
  const migrated = await run(root, ["collection", "migrate", "--from", source, "--preset", "favourite", "--map", "old-widget=@company/widget", "--out", "migrated", "--json"], env);
  assert.equal(migrated.status, 0, migrated.stdout); assert.equal(JSON.parse(migrated.stdout).data.migration.status, "written");
  assert.equal(server.requests.length, 0);
  for (const command of [[], ["create"], ["migrate"]]) {
    const help = await run(root, ["--json", "collection", ...command, "--help"], env, [blocker, analysisBlocker]);
    assert.equal(help.status, 0, help.stderr); assert.match(JSON.parse(help.stdout).data.help, /Usage: shadcn-plus collection/);
  }
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const imported = await execute(process.execPath, ["--import", blocker, "--import", analysisBlocker, "--input-type=module", "--eval", `const api=await import(${JSON.stringify(entry)});for(const key of ['createCollection','readCollection','migrateLegacyPresets'])if(typeof api[key]!=='function')throw Error(key);console.log('lazy');`], { cwd: root, env, encoding: "utf8", timeout: 10000 });
  assert.equal(imported.stdout, "lazy\n");
});

test("collection installation uses the existing qualified multi-registry add path and consent", async t => {
  const { root, env, server } = await fixture(t), path = join(root, "app.collection.json");
  await writeCollection(createCollection({ name: "App", items: ["card", "@company/widget"] }), path);
  const declined = await run(root, ["collection", "install", path, "--json"], env);
  assert.equal(declined.status, 2); assert.equal(JSON.parse(declined.stdout).error.code, "INTERACTIVE_REQUIRED"); assert.equal(server.requests.length, 0);
  env.SHADCN_PLUS_WRITE_FILES = JSON.stringify({ "ui/card.tsx": content, "private/widget.tsx": content });
  const result = await run(root, ["collection", "install", path, "--yes", "--json", "--no-cache"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stderr, "");
  const data = JSON.parse(result.stdout).data; assert.deepEqual(data.installed, ["@shadcn/card", "@company/widget"]); assert.equal(data.verifiedFiles, 2);
  const args = JSON.parse(readFileSync(env.SHADCN_PLUS_ARGS_FILE, "utf8")); assert.deepEqual(args.args, ["--yes", "shadcn@4.23.0", "add", "--yes", "--", "@shadcn/card", "@company/widget"]);
  assert.doesNotMatch(result.stdout + result.stderr, /collections-secret/);
});
