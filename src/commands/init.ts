// src/commands/init.ts
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
import { installComponents } from "../utils/installComponents.js";
import { allComponents } from "../lib/components.js";
import { createCustomPresetFlow } from "../utils/createCustomPreset.js";

export async function runInitUI() {
  renderTitle();

  intro(chalk.bgCyan("Compadcn"));
  const components = await multiselect({
    message: `Pick the components to install:
${chalk.gray(
  "Use [arrows] to navigate, [space] to toggle, [a] to toggle all, [enter] to confirm"
)}`,
    options: allComponents.map((comp) => ({
      label: comp.label,
      value: comp.value,
    })),
    maxItems: 10,
    initialValues: [],
  });

  if (isCancel(components)) {
    outro(chalk.red("Cancelled"));
    process.exit(0);
  }

  const componentLabels = (components as string[])
    .map((compValue) => {
      const component = allComponents.find((comp) => comp.value === compValue);
      return `  • ${component?.label || compValue}`;
    })
    .join("\n");

  note(`${chalk.green("Selected components:")}\n${componentLabels}`);

  const saveAsPreset = await confirm({
    message: "Would you like to save this selection as a preset?",
    initialValue: false,
  });

  if (isCancel(saveAsPreset)) {
    cancel(chalk.red("Cancelled"));
    process.exit(0);
  }
  try {
    if (saveAsPreset) {
      const presetId = await createCustomPresetFlow(components as string[]);
      if (presetId) {
        log.success(chalk.green("Preset saved successfully!"));
      } else {
        log.error(chalk.yellow("Preset creation cancelled or failed."));
      }
    }
  } catch (error) {
    log.error(chalk.red("Failed to create preset. Please try again."));
    process.exit(1);
  }

  const confirmInstall = await confirm({
    message: "Proceed with installation?",
    initialValue: true,
  });

  if (isCancel(confirmInstall) || !confirmInstall) {
    cancel(chalk.red("Cancelled"));
    process.exit(0);
  }

  try {
    await installComponents(components as string[]);
    outro(chalk.cyan("Done! Components have been installed successfully."));
  } catch (error) {
    outro(chalk.red("Installation failed. Please check the error above."));
    process.exit(1);
  }
}
