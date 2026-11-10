import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildInventory } from "../dist/inventory/build.js";
import { mapFile } from "../dist/inventory/files.js";
import { discoverProject } from "../dist/project/discover.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../fixtures/registry/server.mjs";

const aliases = { ui: "@/components/ui", components: "@/components", lib: "@/lib", hooks: "@/hooks", utils: "@/lib/utils" };
const config = (url, extra = {}) => JSON.stringify({ style: "new-york", aliases, registries: { "@shadcn": `${url}/official/{name}.json`, "@custom": `${url}/custom/{name}.json` }, ...extra });
const button = { name: "button", type: "registry:ui", files: [{ path: "registry/ui/button.tsx", type: "registry:ui", content: "export const Button = 1;" }] };
const widget = { name: "widget", type: "registry:block", dependencies: ["motion"], registryDependencies: ["@shadcn/button"], files: [
  { path: "widget.tsx", type: "registry:component", target: "@components/widget/index.tsx", content: "export const Widget = 1;" },
  { path: "use-widget.ts", type: "registry:hook", target: "@hooks/use-widget.ts", content: "export const useWidget = 1;" },
] };

function project(t, url, extra = {}) {
  return createProject(t, {
    "package.json": '{"name":"web","dependencies":{"react":"19","vite":"7"}}',
    "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    "components.json": config(url), ...extra,
  });
}

async function serverWithItems(t, official = [button], custom = [widget]) {
  return registryServer(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    const items = path.startsWith("/official/") ? official : custom;
    if (path.endsWith("/registry.json")) return json(res, catalog(items.map(({ files, ...item }) => ({ ...item, files: files?.map(({ content, ...file }) => file) }))));
    const name = path.split("/").at(-1).replace(/\.json$/, "");
    const item = items.find((item) => item.name === name);
    if (item) json(res, item); else { res.writeHead(404); res.end(); }
  });
}

test("catalog availability is distinct from local files and multi-file ownership candidates", async (t) => {
  const server = await serverWithItems(t);
  const root = project(t, server.url, {
    "src/components/ui/button.tsx": "export const Button = 1;",
    "src/components/widget/index.tsx": "customized widget",
    "src/hooks/use-widget.ts": "export const useWidget = 1;",
    "src/components/ui/local-only.tsx": "export {};",
  });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.complete, true, JSON.stringify(report.diagnostics));
  assert.equal(report.counts.catalogItems, 2);
  assert.equal(report.counts.presentItemCandidates, 2);
  assert.equal(report.counts.localFiles, 4);
  assert.equal(report.counts.unknownFiles, 1);
  const custom = report.items.find(({ name }) => name === "widget");
  assert.equal(custom.manifest, "fetched");
  assert.equal(custom.mappedFiles.length, 2);
  assert.equal(custom.mappedFiles[0].comparison, "different-or-transformed");
  assert.equal(custom.mappedFiles[1].comparison, "exact-remote");
  assert.equal(custom.originConfidence, "candidate");
  assert.deepEqual(custom.dependencies, ["motion"]);
  assert.equal(custom.registryDependencies[0].reference, "@shadcn/button");
  assert.equal(report.files.find(({ path }) => path.endsWith("local-only.tsx")).origin, "unknown");
});

test("uninstalled catalog entries do not become installed candidates or force manifest downloads", async (t) => {
  const server = await serverWithItems(t);
  const root = project(t, server.url);
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.counts.catalogItems, 2);
  assert.equal(report.counts.presentItemCandidates, 0);
  assert.equal(report.counts.localFiles, 0);
  assert.ok(report.items.every(({ presence }) => presence === "absent"));
  assert.equal(server.requests.length, 2);
});

test("metadata-only catalogs inspect manifests based on local filenames and directory names", async (t) => {
  const server = await registryServer(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname;
    if (path.endsWith("registry.json")) return json(res, catalog([{ name: "widget", type: "registry:block" }]));
    json(res, widget);
  });
  const root = project(t, server.url, {
    "components.json": config(server.url, { registries: { "@custom": `${server.url}/custom/{name}.json`, "@shadcn": `${server.url}/custom/{name}.json` } }),
    "src/components/widget/index.tsx": "custom", "src/hooks/use-widget.ts": "custom",
  });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.counts.presentItemCandidates, 1);
  assert.equal(report.counts.catalogAddresses, 2);
  assert.equal(report.counts.ambiguousFiles, 0);
  assert.equal(server.requests.filter(({ path }) => path.endsWith("widget.json")).length, 1);
});

test("different registries claiming the same file remain ambiguous", async (t) => {
  const server = await serverWithItems(t, [button], [button]);
  const root = project(t, server.url, { "src/components/ui/button.tsx": "export const Button = 1;" });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.counts.localFiles, 1);
  assert.equal(report.counts.ambiguousFiles, 1);
  assert.equal(report.files[0].ownerCandidates.length, 2);
  assert.ok(report.items.every(({ originConfidence }) => originConfidence === "ambiguous"));
});

test("partial multi-file items preserve missing-file evidence", async (t) => {
  const server = await serverWithItems(t);
  const root = project(t, server.url, { "src/components/widget/index.tsx": "custom" });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  const item = report.items.find(({ name }) => name === "widget");
  assert.equal(item.presence, "partial");
  assert.equal(report.counts.partialItemCandidates, 1);
  assert.equal(item.mappedFiles.filter(({ present }) => !present).length, 1);
});

test("colliding targets inside one manifest remain an explicit incomplete mapping", async (t) => {
  const collision = { ...button, files: [...button.files, { path: "other/button.tsx", type: "registry:ui", target: "@ui/button.tsx" }] };
  const server = await serverWithItems(t, [collision], []);
  const root = project(t, server.url, { "src/components/ui/button.tsx": "custom" });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.complete, false);
  assert.ok(report.items[0].diagnostics.some(({ code }) => code === "FILE_TARGET_COLLISION"));
});

test("Next.js page targets distinguish existing app and pages routers", (t) => {
  for (const [directory, expected] of [["src/app/demo", "src/app/example/page.tsx"], ["pages/demo", "pages/example.tsx"]]) {
    const root = project(t, "https://fixture.example", { "package.json": '{"dependencies":{"next":"16"}}', [`${directory}/index.tsx`]: "" });
    const result = mapFile({ path: "page.tsx", type: "registry:page", target: "app/example/page.tsx" }, discoverProject({ cwd: root }));
    assert.equal(result.path, join(root, expected));
    assert.equal(result.diagnostic, undefined);
  }
});

test("a failed registry does not prevent healthy inventory", async (t) => {
  const server = await registryServer(t, (req, res) => {
    if (req.url.startsWith("/custom/")) { res.writeHead(401); res.end(); }
    else if (req.url.includes("registry.json")) json(res, catalog([button])); else json(res, button);
  });
  const root = project(t, server.url, { "src/components/ui/button.tsx": "custom" });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.complete, false);
  assert.equal(report.counts.incompleteSources, 1);
  assert.equal(report.counts.presentItemCandidates, 1);
  assert.ok(report.sources.some(({ status, diagnostics }) => status === "error" && diagnostics[0].code === "REGISTRY_UNAUTHORIZED"));
});

test("catalog-less sources can inspect known qualified items without inventing a catalog", async (t) => {
  const server = await registryServer(t, (req, res) => {
    if (req.url.includes("registry.json")) { res.writeHead(404); res.end(); } else json(res, button);
  });
  const root = project(t, server.url, { "src/components/ui/button.tsx": "custom" });
  const report = await buildInventory({ cwd: root, cacheDir: false, items: ["@custom/button"] });
  assert.equal(report.complete, false);
  assert.equal(report.counts.catalogItems, 0);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].inCatalog, false);
  assert.equal(report.items[0].presence, "present");
  assert.equal(report.items[0].qualifiedName, "@custom/button");
});

test("manifest failures, wrong names and unsupported targets never become clean absence", async (t) => {
  const server = await registryServer(t, (req, res) => {
    if (req.url.includes("registry.json")) json(res, catalog([button]));
    else json(res, { ...button, name: "other" });
  });
  const root = project(t, server.url, { "src/components/ui/button.tsx": "custom" });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.complete, false);
  assert.ok(report.items.every(({ manifest }) => manifest === "error"));
  assert.equal(report.counts.presentItemCandidates, 2);
  assert.ok(report.items[0].diagnostics.some(({ code }) => code === "REGISTRY_ITEM_MISMATCH"));
});

test("JavaScript projects map TS registry extensions to JSX and JS", async (t) => {
  const server = await serverWithItems(t);
  const root = project(t, server.url, {
    "components.json": config(server.url, { tsx: false }),
    "src/components/widget/index.jsx": "custom", "src/hooks/use-widget.js": "custom",
  });
  const report = await buildInventory({ cwd: root, cacheDir: false });
  assert.equal(report.items.find(({ name }) => name === "widget").presence, "present");
  assert.equal(report.counts.localFiles, 2);
});

test("target placeholders retain nesting, legacy relative targets honor src, and scope escapes fail", (t) => {
  const root = project(t, "https://fixture.example", { "src/components/ui/ai/input.tsx": "custom" });
  const context = discoverProject({ cwd: root });
  const target = (value, type = "registry:ui") => mapFile({ path: "input.tsx", type, target: value }, context);
  assert.equal(target("@ui/ai/input.tsx").path, join(root, "src/components/ui/ai/input.tsx"));
  assert.equal(target("~/config.json").path, join(root, "config.json"));
  assert.equal(target("src/routes/demo.tsx").path, join(root, "src/routes/demo.tsx"));
  for (const value of ["@ui/../../secrets.ts", "~/../outside.ts", "/absolute.ts", "@unknown/file.ts"]) assert.ok(target(value).diagnostic, value);
  assert.equal(target("app/demo/page.tsx", "registry:page").diagnostic.code, "FILE_TARGET_UNSUPPORTED");
});

test("symlinks cannot move registry file targets outside the workspace", (t) => {
  const outside = createProject(t, { "button.tsx": "external" });
  const root = project(t, "https://fixture.example", { "src/components/ui/keep.tsx": "" });
  symlinkSync(outside, join(root, "src/components/ui/linked"), process.platform === "win32" ? "junction" : "dir");
  const context = discoverProject({ cwd: root });
  const file = mapFile({ path: "button.tsx", type: "registry:ui", target: "@ui/linked/button.tsx" }, context);
  assert.equal(file.diagnostic.code, "FILE_TARGET_OUTSIDE_SCOPE");
  assert.equal(file.present, false);
});

test("workspace namespaces remain scoped and two physical copies are counted separately", async (t) => {
  const server = await serverWithItems(t, [button], []);
  const root = createProject(t, {
    "package.json": '{"workspaces":["apps/*"],"packageManager":"pnpm@10"}',
    ...Object.fromEntries(["a", "b"].flatMap((name) => [
      [`apps/${name}/package.json`, '{"name":"' + name + '","dependencies":{"next":"16"}}'],
      [`apps/${name}/tsconfig.json`, '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}'],
      [`apps/${name}/components.json`, config(server.url, { registries: { "@shadcn": `${server.url}/official/{name}.json` } })],
      [`apps/${name}/src/components/ui/button.tsx`, "custom"],
    ])),
  });
  const report = await buildInventory({ cwd: root, workspace: true, cacheDir: false });
  assert.equal(report.complete, true, JSON.stringify(report.diagnostics));
  assert.equal(report.scopes.length, 2);
  assert.equal(report.counts.catalogItems, 1);
  assert.equal(report.counts.presentItemCandidates, 2);
  assert.equal(report.counts.localFiles, 2);
});

test("workspace exports find shared files once and include the owning registry configuration", async (t) => {
  const server = await serverWithItems(t, [button], []);
  const root = createProject(t, {
    "package.json": '{"workspaces":["apps/*","packages/*"]}',
    "apps/web/package.json": '{"name":"web","dependencies":{"next":"16"}}',
    "apps/web/components.json": config(server.url, { aliases: { ui: "@workspace/ui/components" }, registries: { "@shadcn": `${server.url}/official/{name}.json` } }),
    "packages/ui/package.json": '{"name":"@workspace/ui","peerDependencies":{"react":"19"},"exports":{"./components/*":"./src/components/*.tsx"}}',
    "packages/ui/components.json": config(server.url, { aliases: { ui: "./src/components" }, registries: { "@shadcn": `${server.url}/official/{name}.json` } }),
    "packages/ui/src/components/button.tsx": "custom",
  });
  const report = await buildInventory({ cwd: join(root, "apps/web"), cacheDir: false });
  assert.equal(report.scopes.length, 2);
  assert.equal(report.counts.localFiles, 1);
  assert.equal(report.counts.presentItemCandidates, 1);
  assert.equal(report.counts.ambiguousFiles, 0);
});

test("offline inventory preserves cached metadata without network or project writes", async (t) => {
  const server = await serverWithItems(t);
  const root = project(t, server.url, { "src/components/ui/button.tsx": "custom" });
  const cache = createProject(t);
  const before = readFileSync(join(root, "components.json"), "utf8");
  const online = await buildInventory({ cwd: root, cacheDir: cache });
  const requests = server.requests.length;
  const offline = await buildInventory({ cwd: root, cacheDir: cache, offline: true });
  assert.equal(server.requests.length, requests);
  assert.deepEqual(offline.counts, online.counts);
  assert.equal(offline.complete, true);
  assert.equal(readFileSync(join(root, "components.json"), "utf8"), before);
});

test("invalid item syntax and conflicting modes fail before any network request", async (t) => {
  const server = await serverWithItems(t);
  const root = project(t, server.url);
  await assert.rejects(buildInventory({ cwd: root, cacheDir: false, items: ["button"] }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(buildInventory({ cwd: root, offline: true, refresh: true }), { code: "INVALID_OPTIONS" });
  assert.equal(server.requests.length, 0);
});
