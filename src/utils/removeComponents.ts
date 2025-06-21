import { existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { readFileSync } from "fs";
import { spinner } from "@clack/prompts";
import chalk from "chalk";

interface ComponentsConfig {
  aliases: {
    ui: string;
    components?: string;
  };
}

export async function removeComponents(
  componentNames: string[]
): Promise<void> {
  const s = spinner();
  s.start("Removing component files...");

  try {
    const configPath = join(process.cwd(), "components.json");

    if (!existsSync(configPath)) {
      throw new Error(
        "components.json not found. Make sure you're in a ShadCN project."
      );
    }

    const config: ComponentsConfig = JSON.parse(
      readFileSync(configPath, "utf-8")
    );

    let uiFolderPath = config.aliases.ui;

    if (uiFolderPath.startsWith("@")) {
      uiFolderPath = uiFolderPath.replace("@?/", "src/").replace("@/", "src/");
    }

    const fullUiPath = resolve(process.cwd(), uiFolderPath);

    if (!existsSync(fullUiPath)) {
      throw new Error(`UI components directory not found: ${fullUiPath}`);
    }

    let removedCount = 0;
    const errors: string[] = [];

    for (const componentName of componentNames) {
      const componentPath = join(fullUiPath, `${componentName}.tsx`);

      if (existsSync(componentPath)) {
        try {
          rmSync(componentPath, { force: true });
          removedCount++;
        } catch (error) {
          errors.push(`Failed to remove ${componentName}: ${error}`);
        }
      } else {
        errors.push(`Component file not found: ${componentName}.tsx`);
      }
    }

    if (errors.length > 0) {
      s.stop(chalk.yellow("Completed with warnings"));
      errors.forEach((error) => console.warn(chalk.yellow(error)));
    } else {
      s.stop(chalk.green(`Removed ${removedCount} component files`));
    }
  } catch (error) {
    s.stop(chalk.red("Failed to remove components"));
    throw error;
  }
}
