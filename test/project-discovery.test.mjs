import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { discoverProject } from "../dist/project/discover.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

const config = (aliases = { ui: "@/components/ui" }, extra = {}) => JSON.stringify({ aliases, ...extra });
const manifest = (dependencies, extra = {}) => JSON.stringify({ name: "fixture", dependencies, ...extra });
const paths = (target) => JSON.stringify({ compilerOptions: { paths: { "@/*": [target] } } });
const discover = (cwd) => discoverProject({ cwd, env: {} });

for (const [label, files, expected, framework] of [
  ["Next.js TS with src", { "package.json": manifest({ next: "16", react: "19" }), "tsconfig.json": paths("./src/*") }, "src/components/ui", "next"],
  ["Next.js TS without src", { "package.json": manifest({ next: "16", react: "19" }), "tsconfig.json": paths("./*") }, "components/ui", "next"],
  ["Vite React JS", { "package.json": manifest({ react: "19", vite: "7" }), "jsconfig.json": paths("./src/*"), "components.json": config(undefined, { tsx: false }) }, "src/components/ui", "vite-react"],
  ["Vite React TS references", {
    "package.json": manifest({ react: "19", vite: "7" }),
    "tsconfig.json": '{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}',
    "tsconfig.app.json": paths("./src/*"), "tsconfig.node.json": "{}",
  }, "src/components/ui", "vite-react"],
]) {
  test(`resolves ${label} using declared paths`, (t) => {
    const root = createProject(t, { "components.json": config(), [`${expected}/button.tsx`]: "export {}", ...files });
    const context = discover(root);
    assert.equal(context.ready, true, JSON.stringify(context.diagnostics));
    assert.equal(context.framework, framework);
    assert.equal(context.components.resolvedAliases.ui.path, join(root, expected));
    assert.equal(context.components.resolvedAliases.ui.exists, true);
    if (label.includes(" JS")) assert.equal(context.components.tsx, false);
  });
}

test("JSONC extends retain their originating baseUrl instead of rebasing to the app", (t) => {
  const root = createProject(t, {
    "package.json": '{"workspaces":["apps/*"]}',
    "tsconfig.base.json": '// shared\n{"compilerOptions":{"baseUrl":".","paths":{"~/*":["./shared/*"]}},}',
    "apps/web/package.json": manifest({ next: "16" }),
    "apps/web/tsconfig.json": '{"extends":"../../tsconfig.base.json"}',
    "apps/web/components.json": config({ ui: "~/components/ui", utils: "~/lib/utils" }),
    "shared/components/ui/button.tsx": "", "shared/lib/utils.ts": "",
  });
  const context = discover(join(root, "apps/web"));
  assert.equal(context.ready, true, JSON.stringify(context.diagnostics));
  assert.equal(context.components.resolvedAliases.ui.path, join(root, "shared/components/ui"));
  assert.equal(context.components.resolvedAliases.utils.path, join(root, "shared/lib/utils.ts"));
});

test("inherited paths without baseUrl remain relative to their defining config", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ next: "16" }),
    "config/base.json": paths("../src/*"), "tsconfig.json": '{"extends":"./config/base.json"}',
    "components.json": config(), "src/components/ui/button.tsx": "",
  });
  const context = discover(root);
  assert.equal(context.ready, true, JSON.stringify(context.diagnostics));
  assert.equal(context.components.resolvedAliases.ui.path, join(root, "src/components/ui"));
});

test("package-based extends resolve without executing package code", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ next: "16" }), "components.json": config(),
    "node_modules/@fixture/config/package.json": '{"name":"@fixture/config","tsconfig":"base.json"}',
    "node_modules/@fixture/config/base.json": '{"compilerOptions":{"strict":true}}',
    "tsconfig.json": '{"extends":"@fixture/config","compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
  });
  assert.equal(discover(root).ready, true);
});

test("exact and specific paths win over broad wildcard paths", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ react: "19", vite: "7" }),
    "components.json": config({ ui: "@ui", hooks: "@/hooks" }),
    "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*"],"@/hooks/*":["./special-hooks/*"],"@ui":["./design-system"]}}}',
  });
  const context = discover(root);
  assert.equal(context.ready, true, JSON.stringify(context.diagnostics));
  assert.equal(context.components.resolvedAliases.ui.path, join(root, "design-system"));
  assert.equal(context.components.resolvedAliases.hooks.path, join(root, "special-hooks"));
});

test("local package imports route directory roots, nested folders, and utility extensions", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ react: "19", vite: "7" }, { imports: { "#components/*": "./src/components/*.tsx", "#lib/*": "./src/lib/*.ts" } }),
    "components.json": config({ components: "#components", ui: "#components/ui", lib: "#lib", utils: "#lib/utils" }),
    "tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler","resolvePackageJsonImports":true}}',
    "src/components/ui/button.tsx": "", "src/lib/utils.ts": "",
  });
  const context = discover(root);
  assert.equal(context.ready, true, JSON.stringify(context.diagnostics));
  for (const [name, path] of Object.entries({ components: "src/components", ui: "src/components/ui", lib: "src/lib", utils: "src/lib/utils.ts" })) {
    assert.equal(context.components.resolvedAliases[name].path, join(root, path));
    assert.equal(context.components.resolvedAliases[name].source, "package-imports");
  }
});

test("shared workspace exports work before packages are installed or linked", (t) => {
  const root = createProject(t, {
    "package.json": '{"name":"root","packageManager":"pnpm@10"}',
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "apps/web/package.json": manifest({ react: "19", next: "16", "@workspace/ui": "workspace:*" }),
    "apps/web/components.json": config({ ui: "@workspace/ui/components", utils: "@workspace/ui/lib/utils" }),
    "packages/ui/package.json": '{"name":"@workspace/ui","exports":{"./components/*":"./src/components/*.tsx","./lib/*":"./src/lib/*.ts"}}',
    "packages/ui/src/components/button.tsx": "", "packages/ui/src/lib/utils.ts": "",
  });
  const context = discover(join(root, "apps/web"));
  assert.equal(context.ready, true, JSON.stringify(context.diagnostics));
  assert.equal(context.packageManager.name, "pnpm");
  assert.equal(context.components.resolvedAliases.ui.path, join(root, "packages/ui/src/components"));
  assert.equal(context.components.resolvedAliases.utils.path, join(root, "packages/ui/src/lib/utils.ts"));
  assert.equal(context.components.resolvedAliases.ui.source, "workspace-exports");
});

test("workspace package self-exports work in the shared UI package", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ react: "19" }, { name: "@workspace/ui", exports: { "./components/*": "./src/components/*.tsx" } }),
    "components.json": config({ ui: "@workspace/ui/components" }),
  });
  assert.equal(discover(root).components.resolvedAliases.ui.path, join(root, "src/components"));
});

test("relative paths and absent installation directories are explicit without guessing src", (t) => {
  const root = createProject(t, { "package.json": manifest({ react: "19" }), "components.json": config({ ui: "./widgets" }) });
  const context = discover(root);
  assert.equal(context.ready, true);
  assert.equal(context.components.resolvedAliases.ui.path, join(root, "widgets"));
  assert.equal(context.components.resolvedAliases.ui.exists, false);
  assert.ok(context.diagnostics.some(({ code }) => code === "UI_DIRECTORY_MISSING"));
});

for (const [label, extra, code] of [
  ["missing alias mapping", {}, "ALIAS_UNRESOLVED"],
  ["unmapped baseUrl", { "tsconfig.json": '{"compilerOptions":{"baseUrl":"."}}' }, "ALIAS_UNRESOLVED"],
  ["multiple destinations", { "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["./src/*","./other/*"]}}}' }, "ALIAS_AMBIGUOUS"],
  ["conflicting references", { "tsconfig.json": '{"references":[{"path":"./a.json"},{"path":"./b.json"}]}', "a.json": paths("./src/*"), "b.json": paths("./other/*") }, "ALIAS_AMBIGUOUS"],
  ["external alias", { "tsconfig.json": paths("../outside/*") }, "ALIAS_OUTSIDE_WORKSPACE"],
  ["missing extends", { "tsconfig.json": '{"extends":"./missing.json"}' }, "COMPILER_CONFIG_INVALID"],
  ["extends cycle", { "tsconfig.json": '{"extends":"./a.json"}', "a.json": '{"extends":"./tsconfig.json"}' }, "COMPILER_CONFIG_INVALID"],
  ["reference cycle", { "tsconfig.json": '{"references":[{"path":"./a.json"}]}', "a.json": '{"references":[{"path":"./tsconfig.json"}]}' }, "CONFIG_REFERENCE_CYCLE"],
  ["missing reference", { "tsconfig.json": '{"references":[{"path":"./missing.json"}]}' }, "COMPILER_CONFIG_INVALID"],
  ["malformed compiler config", { "tsconfig.json": '{"compilerOptions":' }, "COMPILER_CONFIG_INVALID"],
  ["malformed components config", { "components.json": "{" }, "CONFIG_INVALID"],
  ["empty aliases", { "components.json": config({ ui: "" }) }, "CONFIG_INVALID"],
  ["invalid tsx", { "components.json": config(undefined, { tsx: "false" }) }, "CONFIG_INVALID"],
  ["conflicting package managers", { "pnpm-lock.yaml": "", "package-lock.json": "" }, "PACKAGE_MANAGER_CONFLICT"],
]) {
  test(`incomplete discovery reports ${label}`, (t) => {
    const root = createProject(t, { "package.json": manifest({ next: "16" }), "components.json": config(), ...extra });
    const context = discover(root);
    assert.equal(context.ready, false);
    assert.ok(context.diagnostics.some((diagnostic) => diagnostic.code === code), JSON.stringify(context.diagnostics));
  });
}

test("conditional exports with different destinations remain ambiguous", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ react: "19" }, { name: "ui", exports: { "./components/*": { import: "./src/*.tsx", require: "./other/*.js" } } }),
    "components.json": config({ ui: "ui/components" }),
  });
  assert.ok(discover(root).diagnostics.some(({ code }) => code === "ALIAS_AMBIGUOUS"));
});

test("unexported workspace paths and file-valued directory aliases are not guessed", (t) => {
  const root = createProject(t, {
    "package.json": manifest({ react: "19" }, { name: "ui", exports: { "./components": "./src/index.ts" } }),
    "components.json": config({ ui: "ui/private", components: "ui/components" }),
  });
  const context = discover(root);
  assert.equal(context.ready, false);
  assert.ok(context.diagnostics.some(({ code }) => code === "ALIAS_UNRESOLVED"));
  assert.ok(context.diagnostics.some(({ code }) => code === "ALIAS_TARGET_UNSUPPORTED"));
});

test("symlink targets outside the project are detected even for an uncreated child", (t) => {
  const outside = createProject(t);
  const root = createProject(t, {
    "package.json": manifest({ next: "16" }), "components.json": config({ ui: "./linked/not-created" }),
  });
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.ok(discover(root).diagnostics.some(({ code }) => code === "ALIAS_OUTSIDE_WORKSPACE"));
});

test("workspace roots require explicit package selection instead of selecting an arbitrary app", (t) => {
  const root = createProject(t, {
    "package.json": '{"workspaces":["apps/*"]}',
    "apps/web/package.json": manifest({ next: "16" }), "apps/web/components.json": config({ ui: "./components/ui" }),
  });
  const context = discover(root);
  assert.equal(context.projectRoot, root);
  assert.equal(context.ready, false);
  assert.equal(context.workspace.packages.length, 2);
  assert.ok(context.diagnostics.some(({ code }) => code === "CONFIG_NOT_FOUND"));
});

test("discovery reports framework uncertainty and never includes registry credentials", (t) => {
  const root = createProject(t, {
    "package.json": "{}",
    "components.json": JSON.stringify({ aliases: { ui: "./components/ui" }, registries: { "@secret": { url: "https://private.example/{name}", headers: { Authorization: "secret-credential" } } } }),
  });
  const context = discover(root);
  assert.equal(context.framework, "unknown");
  assert.ok(context.diagnostics.some(({ code }) => code === "FRAMEWORK_UNRECOGNIZED"));
  assert.equal(JSON.stringify(context).includes("secret-credential"), false);
});
