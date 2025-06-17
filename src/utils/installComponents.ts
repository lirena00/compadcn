import { execa } from "execa";
import { spinner } from "@clack/prompts";
import chalk from "chalk";
import { buildInstallCommand } from "./buildInstallCommand.js";
import { getUserPkgManager } from "./getUserPkgManager.js";

export const installComponents = async (
  components: string[]
): Promise<void> => {
  const packageManager = getUserPkgManager();
  const { command, args } = buildInstallCommand(packageManager, components);

  const s = spinner();
  s.start(`Installing components using ${packageManager}...`);

  try {
    await execa(command, args, {
      cwd: process.cwd(),
    });
    s.stop("✅ Components installed successfully");
  } catch (error) {
    s.stop("❌ Installation failed");
    console.error(chalk.red("Error installing components:"));

    if (error instanceof Error) {
      console.error(chalk.red(error.message));
    }

    throw error;
  }
};
