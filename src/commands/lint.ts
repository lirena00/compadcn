import { intro, outro, note, log, confirm, isCancel } from "@clack/prompts";

import chalk from "chalk";
import { scanForUsedComponents } from "../utils/scanForUsedComponents.js";
import { getInstalledComponents } from "../utils/getInstalledComponents.js";

export async function runLintUI() {
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

    note(
      unusedComponents.map((component) => `• ${component}`).join("\n"),
      chalk.yellow("Unused Components")
    );

    const removeCommand = `compadcn remove ${unusedComponents.join(" ")}`;
    note(chalk.cyan(removeCommand), "Command to remove unused components");

    const shouldRemove = await confirm({
      message: "Would you like to remove these unused components now?",
      initialValue: false,
    });

    if (isCancel(shouldRemove)) {
      outro(chalk.yellow("Linting cancelled"));
      return;
    }

    if (shouldRemove) {
      log.step("Removing unused components...");

      try {
        const { runRemoveUI } = await import("./remove.js");
        await runRemoveUI(unusedComponents);

        outro(chalk.green("✨ Unused components removed successfully!"));
      } catch (removeError) {
        log.error(chalk.red("Error removing components"));
        console.error(removeError);
        outro(
          chalk.red(
            "Failed to remove components. You can run the command manually."
          )
        );
      }
    } else {
      outro(
        chalk.blue(
          "Component linting complete. Run the command above when ready."
        )
      );
    }
  } catch (error) {
    log.error(chalk.red("Error during component linting"));
    console.error(error);
    outro(chalk.red("Failed to run component linter."));
    return;
  }
}
