// src/commands/preset.ts

import {
  intro,
  outro,
  spinner,
  multiselect,
  select,
  confirm,
  isCancel,
  note,
} from "@clack/prompts";
import chalk from "chalk";
import { renderTitle } from "../utils/renderTitle.js";
import {
  getUserPkgManager,
  type PackageManager,
} from "../utils/getUserPkgManager.js";
import { execa } from "execa";
import {
  presets,
  type Component,
  type Preset,
  type PresetsData,
} from "../lib/presets_config.js";

// Helper function to build the install command
function buildInstallCommand(
  packageManager: PackageManager,
  components: string[]
): { command: string; args: string[] } {
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
}

// Helper function to execute the install command
async function installComponents(components: Component[]): Promise<void> {
  const packageManager = getUserPkgManager();
  const componentValues = components.map((comp) => comp.value);
  const { command, args } = buildInstallCommand(
    packageManager,
    componentValues
  );

  const s = spinner();
  s.start(`Installing components using ${packageManager}...`);

  try {
    await execa(command, args, {
      // stdio: "inherit", // This will show the output from shadcn CLI
      cwd: process.cwd(),
    });
    s.stop("✅ Components installed successfully");
  } catch (error) {
    s.stop("❌ Installation failed");
    console.error(chalk.red("Error installing components:"));

    // Enhanced error handling for execa
    if (error instanceof Error) {
      console.error(chalk.red(error.message));
    }

    throw error;
  }
}

export async function runPresetUI() {
  renderTitle();

  const presetsData = presets as PresetsData;

  // First, let user choose a preset
  const selectedPreset = await select({
    message: "Choose a preset to install:",
    options: Object.entries(presetsData.presets).map(([key, preset]) => ({
      label: preset.label,
      value: key,
      hint: preset.description,
    })),
  });

  if (isCancel(selectedPreset)) {
    outro(chalk.yellow("Cancelled"));
    process.exit(0);
  }

  const preset = presetsData.presets[selectedPreset as string] as Preset;

  // Check if preset has components
  if (preset?.components.length === 0) {
    note(
      chalk.yellow("This preset doesn't have any components yet."),
      "Empty preset"
    );
    outro(
      chalk.yellow("Please choose a different preset or use custom install.")
    );
    return;
  }

  // Show user what components will be installed
  const componentList = preset.components
    .map((comp) => `  • ${comp.label}`)
    .join("\n");

  note(
    `${chalk.cyan("Components to be installed:")}\n${componentList}`,
    `${preset?.label} (${preset?.components.length} components)`
  );

  // Ask if they want to edit the preset
  const wantToEdit = await confirm({
    message: "Would you like to customize this preset?",
    initialValue: false,
  });

  if (isCancel(wantToEdit)) {
    outro(chalk.yellow("Cancelled"));
    process.exit(0);
  }

  let finalComponents = preset?.components;

  if (wantToEdit) {
    // Only show components from the selected preset, all pre-selected
    const preSelectedValues = preset.components.map((comp) => comp.value);

    const customComponents = await multiselect({
      message: `Customize your component selection:
${chalk.gray(
  "Use [arrows] to navigate, [space] to toggle, [a] to toggle all, [enter] to confirm"
)}`,
      options: preset?.components.map((comp) => ({
        label: comp.label,
        value: comp.value,
      })),
      initialValues: preSelectedValues,
    });

    if (isCancel(customComponents)) {
      outro(chalk.yellow("Cancelled"));
      process.exit(0);
    }

    // Filter to only include selected components
    finalComponents = preset.components.filter((comp) =>
      (customComponents as string[]).includes(comp.value)
    );
  }

  // Check if any components are selected
  if (finalComponents.length === 0) {
    outro(chalk.yellow("No components selected. Installation cancelled."));
    return;
  }

  // Final confirmation with updated component list
  const finalComponentList = finalComponents
    .map((comp) => `  • ${comp.label}`)
    .join("\n");

  const packageManager = getUserPkgManager();
  const componentValues = finalComponents.map((comp) => comp.value);
  const command = buildInstallCommand(packageManager, componentValues);

  note(
    `${chalk.green("Final selection:")}\n${finalComponentList}

${chalk.gray("Command to be executed:")}
${chalk.blue(`${command.command} ${command.args.join(" ")}`)}`,
    `Installing ${finalComponents.length} components with ${packageManager}`
  );

  const confirmInstall = await confirm({
    message: "Proceed with installation?",
    initialValue: true,
  });

  if (isCancel(confirmInstall) || !confirmInstall) {
    outro(chalk.yellow("Cancelled"));
    process.exit(0);
  }

  // Ask if they want to save this as a new preset (if they edited and removed some components)
  if (wantToEdit && finalComponents.length !== preset?.components.length) {
    const saveAsPreset = await confirm({
      message:
        "Would you like to save this customized selection as a new preset?",
      initialValue: false,
    });

    if (isCancel(saveAsPreset)) {
      outro(chalk.yellow("Cancelled"));
      process.exit(0);
    }

    if (saveAsPreset) {
      // TODO: save components to a config file
      console.log(chalk.green("Custom preset saved! (not really, yet)"));
    }
  }

  // Actually install the components
  try {
    await installComponents(finalComponents);
    outro(chalk.cyan("Done! Components have been installed successfully."));
  } catch (error) {
    outro(chalk.red("Installation failed. Please check the error above."));
    process.exit(1);
  }
}
