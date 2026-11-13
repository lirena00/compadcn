import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

writeFileSync(process.env.SHADCN_PLUS_ARGS_FILE, JSON.stringify({
  pid: process.pid,
  command: process.argv[2],
  args: process.argv.slice(3),
  cwd: process.cwd(),
  ...(process.env.SHADCN_PLUS_READ_STDIN ? { stdin: readFileSync(0, "utf8") } : {}),
}));
console.log("Simulated package-manager output");
if (process.env.SHADCN_PLUS_PM_EXIT) {
  console.error("Simulated package-manager failure");
  process.exitCode = Number(process.env.SHADCN_PLUS_PM_EXIT);
} else if (process.env.SHADCN_PLUS_WRITE_FILES) {
  for (const [name,content] of Object.entries(JSON.parse(process.env.SHADCN_PLUS_WRITE_FILES))) {
    const path=resolve(name),root=resolve(process.cwd());
    if(!path.startsWith(root+sep))throw new Error("Fixture write left the selected project");
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);
  }
}
if(process.env.SHADCN_PLUS_PM_DELAY_MS)await new Promise((resolve)=>setTimeout(resolve,Number(process.env.SHADCN_PLUS_PM_DELAY_MS)));
