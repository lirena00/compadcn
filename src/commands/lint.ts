import {
  intro,
  outro,
  multiselect,
  confirm,
  cancel,
  isCancel,
  note,
} from "@clack/prompts";
import { log } from "@clack/prompts";
import chalk from "chalk";
import { renderTitle } from "../utils/renderTitle.js";
import { scanForUsedComponents } from "../utils/scanForUsedComponents.js";
import { getInstalledComponents } from "../utils/getInstalledComponents.js";

export async function runLintUI() {
  renderTitle();
  intro(chalk.bgMagenta("Component Linter"));

  try {
    // Get installed components from the UI folder
    log.step("Fetching installed components...");
    const installedComponents = await getInstalledComponents();

    if (installedComponents.length === 0) {
      outro(
        chalk.yellow(
          "No ShadCN components found. Make sure you have components installed."
        )
      );
      return;
    }

    log.success(
      chalk.green(`Found ${installedComponents.length} installed components`)
    );

    log.step("Scanning for component usage...");
    const usedComponents = await scanForUsedComponents(installedComponents);
    const unusedComponents = installedComponents.filter(
      (component) => !usedComponents.includes(component)
    );

    log.success(
      chalk.green(`${usedComponents.length} components are being used`)
    );

    if (unusedComponents.length === 0) {
      outro(
        chalk.green("🎉 All components are being used! No cleanup needed.")
      );
      return;
    }

    log.warn(
      chalk.yellow(`${unusedComponents.length} unused components found`)
    );

    // Show unused components in a note
    note(
      unusedComponents.map((component) => `• ${component}`).join("\n"),
      chalk.yellow("Unused Components")
    );

    // Show removal command
    const removeCommand = `compadcn remove ${unusedComponents.join(" ")}`;
    note(
      chalk.cyan(removeCommand),
      "Run this command to remove unused components"
    );

    outro(chalk.blue("Component linting complete"));
  } catch (error) {
    log.error(chalk.red("Error during component linting"));
    console.error(error);
    outro(chalk.red("Failed to run component linter."));
    return;
  }
}
