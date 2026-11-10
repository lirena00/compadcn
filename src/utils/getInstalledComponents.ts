import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { CliError, toCliError } from "../core/errors.js";

interface ComponentsConfig {
  aliases: {
    ui: string;
    components?: string;
  };
}

export async function getInstalledComponents(): Promise<string[]> {
  try {
    const configPath = join(process.cwd(), "components.json");
    // console.log(configPath);

    if (!existsSync(configPath)) {
      throw new CliError(
        "CONFIG_NOT_FOUND", "components.json not found. Make sure you're in a shadcn project."
      );
    }

    const config: ComponentsConfig = JSON.parse(
      readFileSync(configPath, "utf-8")
    );

    if (!config || typeof config.aliases?.ui !== "string" || !config.aliases.ui.trim()) {
      throw new CliError("CONFIG_INVALID", "components.json must define a nonempty aliases.ui path.");
    }

    let uiFolderPath = config.aliases.ui;

    if (uiFolderPath.startsWith("@")) {
      uiFolderPath = uiFolderPath.replace("@?/", "src/").replace("@/", "src/");
    }

    const fullUiPath = resolve(process.cwd(), uiFolderPath);

    if (!existsSync(fullUiPath)) {
      return [];
    }

    const files = readdirSync(fullUiPath);
    const componentFiles = files.filter((file) => {
      const filePath = join(fullUiPath, file);
      const isFile = statSync(filePath).isFile();
      return isFile && file.endsWith(".tsx") && !file.endsWith(".d.ts");
    });

    return componentFiles.map((file) => file.replace(/\.(tsx)$/, ""));
  } catch (error) {
    throw toCliError(error, "COMPONENT_SCAN_FAILED", "Could not read installed components.");
  }
}
