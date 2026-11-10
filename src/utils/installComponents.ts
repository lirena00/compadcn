import { execa } from "execa";
import { log } from "@clack/prompts";
import { getUserPkgManager } from "./getUserPkgManager.js";
import { CliError, toCliError } from "../core/errors.js";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const buildInstallCommand = (
  packageManager: PackageManager,
  components: string[],
  options?: { overwrite?: boolean; cssVariables?: boolean }
): { command: string; args: string[] } => {
  const baseArgs = ["shadcn@latest", "add", ...components];

  if (options?.overwrite) {
    baseArgs.push("--overwrite");
  }
  if (options?.cssVariables !== undefined) {
    throw new CliError(
      "UNSUPPORTED_INSTALL_OPTION",
      "Configure tailwind.cssVariables in components.json. shadcn add does not accept CSS-variable flags."
    );
  }

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
  options?: { overwrite?: boolean; cssVariables?: boolean }
): Promise<void> => {
  if (components.length === 0) return;
  const packageManager = getUserPkgManager();
  const { command, args } = buildInstallCommand(
    packageManager,
    components,
    options
  );

  log.step(`Installing components using ${packageManager}...`);

  try {
    await execa(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    log.success("Components installed successfully");
  } catch (error) {
    throw toCliError(error, "INSTALL_FAILED", "Component installation failed.");
  }
};
