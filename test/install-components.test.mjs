import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
