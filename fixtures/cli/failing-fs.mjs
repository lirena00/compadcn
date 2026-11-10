import * as fs from "node:fs";
export * from "node:fs";

export function readFileSync(path, ...args) {
  if (String(path).endsWith(process.env.SHADCN_PLUS_READ_FAIL)) {
    throw Object.assign(new Error("Simulated source read failure"), { code: "EACCES" });
  }
  return fs.readFileSync(path, ...args);
}
