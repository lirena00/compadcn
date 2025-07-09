import { execa } from "execa";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import { getUserPkgManager } from "./getUserPkgManager.js";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const buildInstallCommand = (
  packageManager: PackageManager,
  components: string[],
  options?: { overwrite?: boolean }
): { command: string; args: string[] } => {
  const baseArgs = ["shadcn@latest", "add", ...components];

  if (options?.overwrite) {
    baseArgs.push("--overwrite");
  }

  baseArgs.push(...components);

  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", ...baseArgs] };
    case "yarn":
      return { command: "yarn", args: ["dlx", ...baseArgs] };
    case "bun":
      return { command: "bunx", args: ["--bun", ...baseArgs] };
    case "npm":
    default:
      return { command: "npx", args: ["--yes", ...baseArgs] };
  }
};

export const installComponents = async (
  components: string[],
  options?: { overwrite?: boolean }
): Promise<void> => {
  const packageManager = getUserPkgManager();
  const { command, args } = buildInstallCommand(
    packageManager,
    components,
    options
  );

  const s = spinner();
  s.start(`Installing components using ${packageManager}...`);

  try {
    await execa(command, args, {
      cwd: process.cwd(),
    });
    s.stop(chalk.green("Components installed successfully"));
  } catch (error) {
    s.stop(chalk.red("Installation failed"));

    if (error instanceof Error) {
      console.error(chalk.red(error.message));
    }

    throw error;
  }
};
