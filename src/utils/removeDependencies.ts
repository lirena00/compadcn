import { execa } from "execa";
import { log } from "@clack/prompts";
import { getUserPkgManager } from "./getUserPkgManager.js";
import { toCliError } from "../core/errors.js";

export async function removeDependencies(
  dependencies: string[]
): Promise<void> {
  if (dependencies.length === 0) return;

  const packageManager = getUserPkgManager();
  log.step(`Removing dependencies using ${packageManager}...`);

  try {
    const { command, args } = buildRemoveCommand(packageManager, dependencies);

    await execa(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    log.success("Dependencies removed successfully");
  } catch (error) {
    throw toCliError(error, "DEPENDENCY_REMOVAL_FAILED", "Dependency removal failed.");
  }
}

function buildRemoveCommand(
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  dependencies: string[]
): { command: string; args: string[] } {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["remove", ...dependencies] };
    case "yarn":
      return { command: "yarn", args: ["remove", ...dependencies] };
    case "bun":
      return { command: "bun", args: ["remove", ...dependencies] };
    case "npm":
    default:
      return { command: "npm", args: ["uninstall", ...dependencies] };
  }
}
