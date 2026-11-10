import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getUserPkgManager } from "../dist/utils/getUserPkgManager.js";
import { createProject } from "../fixtures/cli/project-fixture.mjs";

test("project declaration takes precedence over the invoking package manager", (t) => {
  const cwd = createProject(t, { "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }) });
  assert.equal(getUserPkgManager({ cwd, env: { npm_config_user_agent: "pnpm/10.0.0" } }), "npm");
});

for (const [file, expected] of Object.entries({
  "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm", "bun.lock": "bun", "bun.lockb": "bun",
})) {
  test(`${file} determines the project manager even when invoked through npm`, (t) => {
    const cwd = createProject(t, { [file]: "" });
    assert.equal(getUserPkgManager({ cwd, env: { npm_config_user_agent: "npm/10.0.0" } }), expected);
  });
}

test("Bun's two lockfile formats are not different package managers", (t) => {
  const cwd = createProject(t, { "bun.lock": "", "bun.lockb": "" });
  assert.equal(getUserPkgManager({ cwd, env: {} }), "bun");
});

test("a nested workspace can inherit package-manager metadata", (t) => {
  const root = createProject(t, { "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }) });
  const cwd = join(root, "packages", "ui");
  mkdirSync(cwd, { recursive: true });
  assert.equal(getUserPkgManager({ cwd, env: {} }), "pnpm");
});

test("conflicting lockfiles are not silently resolved by file order", (t) => {
  const cwd = createProject(t, { "pnpm-lock.yaml": "", "package-lock.json": "" });
  assert.throws(() => getUserPkgManager({ cwd }), { code: "PACKAGE_MANAGER_CONFLICT" });
});

test("a declaration that conflicts with the lockfile fails explicitly", (t) => {
  const cwd = createProject(t, {
    "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }), "yarn.lock": "",
  });
  assert.throws(() => getUserPkgManager({ cwd }), { code: "PACKAGE_MANAGER_CONFLICT" });
});

test("invalid project metadata does not silently choose another manager", (t) => {
  const cwd = createProject(t, { "package.json": "{" });
  assert.throws(() => getUserPkgManager({ cwd }), { code: "PACKAGE_JSON_INVALID" });
});

test("unsupported declared managers fail explicitly", (t) => {
  const cwd = createProject(t, { "package.json": JSON.stringify({ packageManager: "deno@2" }) });
  assert.throws(() => getUserPkgManager({ cwd }), { code: "PACKAGE_MANAGER_UNSUPPORTED" });
});

test("metadata-free projects use the launcher or npm without ESM require or PATH probes", (t) => {
  const cwd = createProject(t);
  assert.equal(getUserPkgManager({ cwd, env: { npm_config_user_agent: "yarn/4.0.0" } }), "yarn");
  assert.equal(getUserPkgManager({ cwd, env: {} }), "npm");
});
