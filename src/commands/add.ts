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
import { installComponents } from "../utils/installComponents.js";
import { allComponents } from "../lib/components.js";
import { getInstalledComponents } from "../utils/getInstalledComponents.js";

export async function runAddUI(componentsToAdd?: string[]) {
  intro(chalk.bgCyan("Add Components"));

  try {
    log.step("Checking installed components...");
    const installedComponents = await getInstalledComponents();

    let finalComponentsToAdd: string[] = [];

    if (componentsToAdd && componentsToAdd.length > 0) {
      const invalidComponents = componentsToAdd.filter(
        (comp) => !allComponents.some((c) => c.value === comp)
      );

      if (invalidComponents.length > 0) {
        log.error(
          chalk.red(
            `The following components do not exist: ${invalidComponents.join(
              ", "
            )}`
          )
        );
        outro(chalk.red("Cannot proceed with installation."));
        return;
      }

      const alreadyInstalled = componentsToAdd.filter((comp) =>
        installedComponents.includes(comp)
      );

      if (alreadyInstalled.length > 0) {
        log.info(
          chalk.yellow(
            `Following components are already installed (skipping): ${alreadyInstalled.join(
              ", "
            )}`
          )
        );
      }

      finalComponentsToAdd = componentsToAdd.filter(
        (comp) => !installedComponents.includes(comp)
      );

      if (finalComponentsToAdd.length === 0) {
        outro(chalk.yellow("All specified components are already installed."));
        return;
      }
    } else {
      const availableComponents = allComponents.filter(
        (comp) => !installedComponents.includes(comp.value)
      );

      if (availableComponents.length === 0) {
        outro(chalk.yellow("All ShadCN components are already installed."));
        return;
      }

      const components = await multiselect({
        message: `Pick the components to install:
${chalk.gray(
  "Use [arrows] to navigate, [space] to toggle, [a] to toggle all, [enter] to confirm"
)}`,
        options: availableComponents.map((comp) => ({
          label: comp.label,
          value: comp.value,
        })),
        maxItems: 10,
        initialValues: [],
      });

      if (isCancel(components)) {
        outro(chalk.red("Cancelled"));
        return;
      }

      finalComponentsToAdd = components as string[];
    }

    if (finalComponentsToAdd.length === 0) {
      outro(chalk.yellow("No components selected for installation."));
      return;
    }

    const componentLabels = finalComponentsToAdd
      .map((compValue) => {
        const component = allComponents.find(
          (comp) => comp.value === compValue
        );
        return `  • ${component?.label || compValue}`;
      })
      .join("\n");

    note(`${chalk.green("Components to be installed:")}\n${componentLabels}`);

    const confirmInstall = await confirm({
      message: "Proceed with installation?",
      initialValue: true,
    });

    if (isCancel(confirmInstall) || !confirmInstall) {
      cancel(chalk.red("Cancelled"));
      return;
    }

    await installComponents(finalComponentsToAdd);
    outro(chalk.cyan("Done! Components have been installed successfully."));
  } catch (error) {
    log.error(chalk.red("Error during component installation"));
    console.error(error);
    outro(chalk.red("Installation failed. Please check the error above."));
  }
}
