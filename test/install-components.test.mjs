import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createProject } from "../fixtures/cli/project-fixture.mjs";
import { stubPackageManagers } from "../fixtures/cli/package-manager-stubs.mjs";

for (const [manager, command, prefix] of [
  ["npm", "npx", ["--yes"]], ["pnpm", "pnpm", ["dlx"]],
  ["yarn", "yarn", ["dlx"]], ["bun", "bunx", ["--bun"]],
]) {
  test(`${manager} installs each requested component once using the project manager`, (t) => {
    const cwd = createProject(t, { "package.json": JSON.stringify({ packageManager: `${manager}@4.0.0` }) });
    const env = stubPackageManagers(cwd);
    env.npm_config_user_agent = "npm/10.0.0";
    const module = new URL("../dist/utils/installComponents.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `const { installComponents } = await import(${JSON.stringify(module)});
       await installComponents(["button", "card"], { overwrite: true });`],
      { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(readFileSync(env.SHADCN_PLUS_ARGS_FILE, "utf8"));
    assert.equal(invocation.command, command);
    assert.deepEqual(invocation.args, [...prefix, "shadcn@latest", "add", "button", "card", "--overwrite"]);
    assert.equal(invocation.cwd, cwd);
  });
}

test("installer input and output are inherited by the subprocess", (t) => {
  const cwd = createProject(t, { "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }) });
  const env = { ...stubPackageManagers(cwd), SHADCN_PLUS_READ_STDIN: "1" };
  const module = new URL("../dist/utils/installComponents.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `const { installComponents } = await import(${JSON.stringify(module)}); await installComponents(["button"]);`],
    { cwd, env, input: "confirmed\n", encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Simulated package-manager output/);
  assert.equal(JSON.parse(readFileSync(env.SHADCN_PLUS_ARGS_FILE, "utf8")).stdin, "confirmed\n");
});

test("an empty install request does not start an interactive upstream picker", (t) => {
  const cwd = createProject(t);
  const env = stubPackageManagers(cwd);
  const module = new URL("../dist/utils/installComponents.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `const { installComponents } = await import(${JSON.stringify(module)}); await installComponents([]);`],
    { cwd, env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(env.SHADCN_PLUS_ARGS_FILE), false);
});

for (const value of [false, true]) {
  test(`legacy CSS-variable option ${value} fails before spawning upstream`, (t) => {
    const cwd = createProject(t);
    const env = stubPackageManagers(cwd);
    const module = new URL("../dist/utils/installComponents.js", import.meta.url).href;
    const script = `const { installComponents } = await import(${JSON.stringify(module)});
      try { await installComponents(["button"], { cssVariables: ${value} }); }
      catch (error) { console.error(error.code); process.exitCode=2; }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script],
      { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /UNSUPPORTED_INSTALL_OPTION/);
    assert.equal(existsSync(env.SHADCN_PLUS_ARGS_FILE), false);
  });
}
