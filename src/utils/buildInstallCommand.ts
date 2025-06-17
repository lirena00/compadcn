type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const buildInstallCommand = (
  packageManager: PackageManager,
  components: string[]
): { command: string; args: string[] } => {
  const baseArgs = ["shadcn@latest", "add", ...components];

  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", ...baseArgs] };
    case "yarn":
      return { command: "yarn", args: ["dlx", ...baseArgs] };
    case "bun":
      return { command: "bunx", args: ["--bun", ...baseArgs] };
    case "npm":
    default:
      return { command: "npx", args: baseArgs };
  }
};
