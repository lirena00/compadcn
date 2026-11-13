import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "shadcn-plus-package-")), stage = join(root, "stage"), consumer = join(root, "consumer");
await mkdir(stage); await mkdir(consumer);
console.error(`Package workspace: ${root}`);
// Compile into an empty staging directory: stale local dist files cannot make
// this check pass or accidentally become package contents.
await execa(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--outDir", join(stage, "dist")], { cwd: repo, stdio: "inherit" });
for (const path of ["package.json", "README.md", "LICENSE"]) await copyFile(join(repo, path), join(stage, path));
for (const path of ["skills", "examples"]) await cp(join(repo, path), join(stage, path), { recursive: true });
await mkdir(join(stage, "docs"));
await copyFile(join(repo, "docs/compatibility.md"), join(stage, "docs/compatibility.md"));
const packed = JSON.parse((await execa("npm", ["pack", "--json", "--ignore-scripts"], { cwd: stage })).stdout)[0];
for (const { path } of packed.files) {
  assert.match(path, /^(?:dist\/|docs\/compatibility\.md$|skills\/shadcn-plus\/SKILL\.md$|examples\/ci\/|README\.md$|LICENSE$|package\.json$)/, `Unexpected archive file: ${path}`);
  assert.doesNotMatch(path, /^(?:dist\/commands\/(?:lint|remove)\.|dist\/utils\/(?:removeComponents|removeImports|removeDependencies|scanForUsedComponents)\.)/, `Obsolete cleanup shipped: ${path}`);
}
await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
await execa("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(stage, packed.filename)], { cwd: consumer, stdio: "inherit" });
const metadata = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const cli = (args) => execa("shadcn-plus", args, { cwd: consumer, preferLocal: true });
assert.equal((await cli(["--version"])).stdout, metadata.version);
assert.match((await cli(["--help"])).stdout, /Usage: shadcn-plus/);
const skill = JSON.parse((await cli(["agent", "skill", "--json"])).stdout);
assert.equal(skill.status, "completed");
const api = await import(pathToFileURL(join(consumer, "node_modules/shadcn-plus/dist/index.js")));
for (const name of ["auditProject", "buildInventory", "buildDependencyGraph", "createCleanupPlan", "applyCleanupPlan", "restoreCleanupOperation", "getAgentSkill"]) assert.equal(typeof api[name], "function", name);
assert.match(JSON.stringify(await api.getAgentSkill()), /shadcn-plus/);
await writeFile(join(consumer, "consumer.ts"), 'import { auditProject, createCleanupPlan, checkProject } from "shadcn-plus";\nvoid auditProject({cwd:".",entries:["src/main.tsx"]});\nvoid createCleanupPlan({mode:"remove",targets:["@private/card"]});\nvoid checkProject({cwd:"."});\n');
await execa(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "consumer.ts"], { cwd: consumer, stdio: "inherit" });
console.log(JSON.stringify({ node: process.version, platform: process.platform, archive: join(stage, packed.filename), files: packed.files.length, bytes: packed.size, installedBin: true, installedAPI: true, installedTypes: true, packagedSkill: true }, null, 2));
