import { existsSync } from "fs";
import { join } from "path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const getUserPkgManager: () => PackageManager = () => {
  // First, check the user agent (works when run through package manager scripts)
  const userAgent = process.env.npm_config_user_agent;

  if (userAgent) {
    if (userAgent.startsWith("yarn")) {
      return "yarn";
    } else if (userAgent.startsWith("pnpm")) {
      return "pnpm";
    } else if (userAgent.startsWith("bun")) {
      return "bun";
    } else if (userAgent.startsWith("npm")) {
      return "npm";
    }
  }

  // Check for lock files in the current working directory
  const cwd = process.cwd();

  if (existsSync(join(cwd, "bun.lockb"))) {
    return "bun";
  }

  if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(join(cwd, "yarn.lock"))) {
    return "yarn";
  }

  if (existsSync(join(cwd, "package-lock.json"))) {
    return "npm";
  }

  // Check which package managers are available in PATH
  try {
    const { execSync } = require("child_process");

    // Check for pnpm first as it's often preferred when available
    try {
      execSync("pnpm --version", { stdio: "ignore" });
      return "pnpm";
    } catch {}

    try {
      execSync("yarn --version", { stdio: "ignore" });
      return "yarn";
    } catch {}

    try {
      execSync("bun --version", { stdio: "ignore" });
      return "bun";
    } catch {}
  } catch {}

  // Default fallback
  return "npm";
};
