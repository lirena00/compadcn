import { readFileSync, writeFileSync } from "node:fs";

writeFileSync(process.env.SHADCN_PLUS_ARGS_FILE, JSON.stringify({
  command: process.argv[2],
  args: process.argv.slice(3),
  cwd: process.cwd(),
  ...(process.env.SHADCN_PLUS_READ_STDIN ? { stdin: readFileSync(0, "utf8") } : {}),
}));
console.log("Simulated package-manager output");
if (process.env.SHADCN_PLUS_PM_EXIT) {
  console.error("Simulated package-manager failure");
  process.exitCode = Number(process.env.SHADCN_PLUS_PM_EXIT);
}
