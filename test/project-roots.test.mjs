import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findProject } from "../dist/project/files.js";
import { findWorkspace } from "../dist/project/workspace.js";
import { getPackageManagerInfo } from "../dist/utils/getUserPkgManager.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

test("nested source directories select their nearest package without changing cwd", (t) => {
  const root = createProject(t, { "package.json": "{}", "apps/web/package.json": '{"name":"web"}' });
  const nested = join(root, "apps/web/src/features");
  mkdirSync(nested, { recursive: true });
  const before = process.cwd();
  assert.equal(findProject(nested).root, join(root, "apps/web"));
  assert.equal(process.cwd(), before);
});

test("project search stops at a Git boundary, including a worktree .git file", (t) => {
  const root = createProject(t, { "package.json": "{}", "nested/.git": "gitdir: somewhere" });
  assert.throws(() => findProject(join(root, "nested")), { code: "PROJECT_NOT_FOUND" });
});

test("invalid or non-directory cwd is explicit", (t) => {
  const root = createProject(t, { "package.json": "{}" });
  for (const path of [join(root, "missing"), join(root, "package.json")]) {
    assert.throws(() => findProject(path), { code: "CWD_INVALID" });
  }
});

for (const workspaces of [["apps/*", "packages/*", "!packages/ignored"], { packages: ["apps/*", "packages/*", "!packages/ignored"] }]) {
  test(`package.json workspace ${Array.isArray(workspaces) ? "array" : "object"} includes only selected packages`, (t) => {
    const root = createProject(t, {
      "package.json": JSON.stringify({ name: "root", workspaces }),
      "apps/web/package.json": '{"name":"web"}',
      "packages/ui/package.json": '{"name":"@workspace/ui"}',
      "packages/ignored/package.json": '{"name":"ignored"}',
      "node_modules/other/package.json": '{"name":"other"}',
    });
    const workspace = findWorkspace(join(root, "apps/web"));
    assert.equal(workspace.root, root);
    assert.deepEqual(workspace.packages.map((pkg) => pkg.name).sort(), ["@workspace/ui", "root", "web"]);
    assert.equal(findWorkspace(join(root, "packages/ignored")), null);
  });
}

test("pnpm YAML takes precedence and supports comments, braces and exclusions", (t) => {
  const root = createProject(t, {
    "package.json": '{"name":"root","workspaces":["wrong/*"]}',
    "pnpm-workspace.yaml": "# workspace\npackages:\n  - '{apps,packages}/*'\n  - '!packages/ignored'\n",
    "apps/web/package.json": '{"name":"web"}',
    "packages/ui/package.json": '{"name":"ui"}',
    "packages/ignored/package.json": '{"name":"ignored"}',
  });
  const workspace = findWorkspace(join(root, "apps/web"));
  assert.equal(workspace.configPath, join(root, "pnpm-workspace.yaml"));
  assert.equal(workspace.packages.length, 3);
});

for (const config of ["packages: [", "packages: invalid", "packages: ['../outside/*']"]) {
  test(`invalid or external workspace scope fails: ${config}`, (t) => {
    const root = createProject(t, { "package.json": "{}", "pnpm-workspace.yaml": config });
    assert.throws(() => findWorkspace(root), (error) => error.code.startsWith("WORKSPACE_"));
  });
}

test("duplicate workspace names cannot select an arbitrary exports target", (t) => {
  const root = createProject(t, {
    "package.json": '{"workspaces":["packages/*"]}',
    "packages/a/package.json": '{"name":"same"}', "packages/b/package.json": '{"name":"same"}',
  });
  assert.throws(() => findWorkspace(root), { code: "WORKSPACE_PACKAGE_AMBIGUOUS" });
});

test("package manager reports inherited provenance and respects a supplied boundary", (t) => {
  const root = createProject(t, { "package.json": '{"packageManager":"pnpm@10"}', "apps/web/package.json": "{}" });
  const cwd = join(root, "apps/web");
  assert.deepEqual(getPackageManagerInfo({ cwd, env: {} }), { name: "pnpm", source: "packageManager", directory: root });
  assert.deepEqual(getPackageManagerInfo({ cwd, env: {}, boundary: cwd }), { name: "npm", source: "default", directory: cwd });
});

test("pnpm workspace metadata selects pnpm without a lockfile or launcher", (t) => {
  const root = createProject(t, { "package.json": "{}", "pnpm-workspace.yaml": "" });
  assert.equal(findWorkspace(root).packages.length, 1);
  assert.deepEqual(getPackageManagerInfo({ cwd: root, env: {} }), { name: "pnpm", source: "workspace", directory: root });
});
