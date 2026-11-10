import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError } from "../core/errors.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface DetectionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const lockfiles: Record<string, PackageManager> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

export function getUserPkgManager({
  cwd = process.cwd(), env = process.env,
}: DetectionOptions = {}): PackageManager {
  let directory = resolve(cwd);

  while (true) {
    const managers = new Set(
      Object.entries(lockfiles)
        .filter(([file]) => existsSync(join(directory, file)))
        .map(([, manager]) => manager)
    );
    const manifest = join(directory, "package.json");
    let declared: PackageManager | undefined;

    if (existsSync(manifest)) {
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        throw new CliError("PACKAGE_JSON_INVALID", `Cannot read valid JSON from ${manifest}.`);
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new CliError("PACKAGE_JSON_INVALID", `${manifest} must contain an object.`);
      }
      const value = (data as { packageManager?: unknown }).packageManager;
      if (value !== undefined) {
        const match = typeof value === "string" && /^(npm|pnpm|yarn|bun)(?:@.+)?$/.exec(value);
        if (!match) {
          throw new CliError("PACKAGE_MANAGER_UNSUPPORTED", `Unsupported packageManager in ${manifest}.`);
        }
        declared = match[1] as PackageManager;
      }
    }

    if (managers.size > 1 || (declared && [...managers].some((manager) => manager !== declared))) {
      throw new CliError(
        "PACKAGE_MANAGER_CONFLICT",
        `Conflicting package-manager metadata in ${directory}. Resolve packageManager and lockfiles before continuing.`
      );
    }
    if (declared) return declared;
    if (managers.size === 1) return [...managers][0]!;

    const parent = dirname(directory);
    if (parent === directory || existsSync(join(directory, ".git"))) break;
    directory = parent;
  }

  // The launcher is only a fallback when the project supplies no metadata.
  const launcher = env.npm_config_user_agent?.split("/")[0];
  return ["npm", "pnpm", "yarn", "bun"].includes(launcher ?? "")
    ? launcher as PackageManager
    : "npm";
}
