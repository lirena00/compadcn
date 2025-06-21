import { execa } from "execa";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import { getUserPkgManager } from "./getUserPkgManager.js";

export async function removeDependencies(
  dependencies: string[]
): Promise<void> {
  if (dependencies.length === 0) return;

  const packageManager = getUserPkgManager();
  const s = spinner();
  s.start(`Removing dependencies using ${packageManager}...`);

  try {
    const { command, args } = buildRemoveCommand(packageManager, dependencies);

    await execa(command, args, {
      cwd: process.cwd(),
    });

    s.stop(chalk.green("Dependencies removed successfully"));
  } catch (error) {
    s.stop(chalk.red("Failed to remove dependencies"));

    if (error instanceof Error) {
      console.error(chalk.red(error.message));
    }

    throw error;
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
