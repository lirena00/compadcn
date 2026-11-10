import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export function stubPackageManagers(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = fileURLToPath(new URL("./fake-package-manager.mjs", import.meta.url));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const name of ["npm", "npx", "pnpm", "yarn", "bun", "bunx"]) {
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" ${name} %*\r\n`);
    } else {
      writeFileSync(join(bin, name),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(name)} "$@"\n`,
        { mode: 0o755 });
    }
  }
  const env = { ...process.env, NO_COLOR: "1", SHADCN_PLUS_ARGS_FILE: join(root, "args.json") };
  delete env.FORCE_COLOR;
  // Windows environment variable names are case-insensitive.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = bin + delimiter + (process.env.PATH ?? process.env.Path ?? "");
  env.HOME = root;
  env.USERPROFILE = root;
  return env;
}
