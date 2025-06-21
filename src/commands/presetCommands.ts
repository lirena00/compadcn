import {
  confirm,
  isCancel,
  note,
  outro,
  text,
  multiselect,
} from "@clack/prompts";
import chalk from "chalk";
import { presets } from "../lib/presets_config.js";
import {
  loadCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
} from "../utils/presetStorage.js";
import { installComponents } from "../utils/installComponents.js";
import { allComponents } from "../lib/components.js";
import { findPreset } from "../utils/findPreset.js";

interface ListOptions {
  builtin?: boolean;
  custom?: boolean;
}

export async function listPresets(options: ListOptions = {}) {
  const builtinPresets = presets.presets;
  const customPresets = loadCustomPresets();

  console.log(chalk.cyan.bold("\n Available Presets\n"));

  // Show builtin presets
  if (!options.custom) {
    console.log(chalk.yellow("Built-in Presets:"));
    const builtinEntries = Object.entries(builtinPresets);

    builtinEntries.forEach(([key, preset]) => {
      console.log(
        `  ${chalk.green("•")} ${chalk.bold(preset.label)} - ${
          preset.description
        }`
      );
      console.log(
        `    ${chalk.gray(`Components: ${preset.components.length}`)}`
      );
    });

    console.log();
  }

  // Show custom presets
  if (!options.builtin) {
    console.log(chalk.yellow("Custom Presets:"));
    const customEntries = Object.entries(customPresets.presets);

    if (customEntries.length === 0) {
      console.log(chalk.gray("  No custom presets found."));
    } else {
      customEntries.forEach(([key, preset]) => {
        const createdAt = new Date(preset.createdAt).toLocaleDateString();
        console.log(
          `  ${chalk.green("•")} ${chalk.bold(preset.label)} - ${
            preset.description
          }`
        );
        console.log(
          `    ${chalk.gray(
            `Components: ${preset.components.length} | Created: ${createdAt}`
          )}`
        );
      });
    }
    console.log();
  }
}

export async function showPreset(presetName: string) {
  const preset = await findPreset(presetName);

  if (!preset) {
    outro(chalk.red(` Preset "${presetName}" not found.`));
    return;
  }

  console.log(chalk.cyan.bold(`\n${preset.label}\n`));
  console.log(chalk.gray(preset.description));
  console.log();

  console.log(chalk.yellow("Components:"));
  preset.components.forEach((component) => {
    console.log(
      `  ${chalk.green("•")} ${component.label} ${chalk.gray(
        `(${component.value})`
      )}`
    );
  });

  console.log();
  console.log(chalk.gray(`Total: ${preset.components.length} components`));

  if (preset.isCustom && preset.createdAt) {
    console.log(
      chalk.cyan(`Created: ${new Date(preset.createdAt).toLocaleDateString()}`)
    );
  }
  console.log();
}

export async function installPreset(presetName: string) {
  const preset = await findPreset(presetName);

  if (!preset) {
    outro(chalk.red(` Preset "${presetName}" not found.`));
    return;
  }

  console.log(chalk.cyan(`\n Installing preset: ${preset.label}`));

  const componentList = preset.components
    .map((comp) => `  • ${comp.label}`)
    .join("\n");

  note(
    `${chalk.green("Components to install:")}\n${componentList}`,
    `${preset.label} (${preset.components.length} components)`
  );

  const confirmInstall = await confirm({
    message: "Proceed with installation?",
    initialValue: true,
  });

  if (isCancel(confirmInstall) || !confirmInstall) {
    outro(chalk.yellow("Installation cancelled"));
    return;
  }

  try {
    await installComponents(preset.components.map((comp) => comp.value));
    outro(chalk.green(" Preset installed successfully!"));
  } catch (error) {
    console.error(chalk.red("Installation error:"), error);
    outro(chalk.red("Installation failed. Please check the error above."));
  }
}

export async function createPreset(
  presetName: string,
  components: string[],
  options: { description?: string; base?: string } = {}
) {
  // Validate preset name
  if (!presetName || presetName.trim().length === 0) {
    outro(chalk.red(" Preset name is required."));
    return;
  }

  // Check if preset already exists
  const existingPreset = await findPreset(presetName);
  if (existingPreset) {
    outro(chalk.red(`Preset "${presetName}" already exists.`));
    return;
  }

  let baseComponents: string[] = [];
  if (options.base) {
    const basePreset = await findPreset(options.base);
    if (!basePreset) {
      outro(chalk.red(`Base preset "${options.base}" not found.`));
      return;
    }
    baseComponents = basePreset.components.map((comp) => comp.value);
    console.log(
      chalk.cyan(
        `Using "${basePreset.label}" as base (${baseComponents.length} components)`
      )
    );
  }

  if (!components || components.length === 0) {
    const selectedComponents = await multiselect({
      message: options.base
        ? `Select components for your preset (base components are pre-selected)`
        : "Select components for your preset",
      options: allComponents.map((comp) => ({
        value: comp.value,
        label: comp.label,
      })),
      required: true,
      maxItems: 10,
      initialValues: baseComponents,
    });

    if (isCancel(selectedComponents)) {
      outro(chalk.yellow("Creation cancelled"));
      return;
    }

    components = selectedComponents as string[];
  } else if (options.base && baseComponents.length > 0) {
    // If components are provided via args but we have a base, merge them
    const mergedComponents = [...new Set([...baseComponents, ...components])];
    components = mergedComponents;
    console.log(
      chalk.cyan(
        `Merged base components with provided components (${components.length} total)`
      )
    );
  }

  const invalidComponents = components.filter(
    (comp) => !allComponents.some((c) => c.value === comp)
  );

  if (invalidComponents.length > 0) {
    outro(chalk.red(`Invalid components: ${invalidComponents.join(", ")}`));
    return;
  }

  // Get description if not provided
  let description = options.description;
  if (!description) {
    const descriptionInput = await text({
      message: "Add a description for your preset (optional)",
      placeholder: `Custom preset with ${components.length} components`,
    });

    if (isCancel(descriptionInput)) {
      outro(chalk.yellow("Creation cancelled"));
      return;
    }

    description =
      descriptionInput ||
      (options.base
        ? `Custom preset based on ${options.base} with ${components.length} components`
        : `Custom preset with ${components.length} components`);
  }

  const presetId = presetName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const componentObjects = allComponents.filter((comp) =>
    components.includes(comp.value)
  );

  try {
    saveCustomPreset(presetId, presetName, description, componentObjects);

    console.log(
      chalk.green(`\n Custom preset "${presetName}" created successfully!`)
    );
    console.log(chalk.gray(`   ID: ${presetId}`));
    console.log(chalk.gray(`   Components: ${componentObjects.length}`));
    console.log(chalk.gray(`   Description: ${description}`));
    if (options.base) {
      console.log(chalk.gray(`   Based on: ${options.base}`));
    }
    console.log();
  } catch (error) {
    console.error(chalk.red("Creation error:"), error);
    outro(chalk.red(" Failed to create preset."));
  }
}

export async function deletePreset(presetName: string) {
  const customPresets = loadCustomPresets();

  let presetId = presetName;
  let preset = customPresets.presets[presetName];

  if (!preset) {
    const presetEntry = Object.entries(customPresets.presets).find(
      ([id, p]) => p.label.toLowerCase() === presetName.toLowerCase()
    );

    if (presetEntry) {
      presetId = presetEntry[0];
      preset = presetEntry[1];
    }
  }

  if (!preset) {
    outro(chalk.red(` Custom preset "${presetName}" not found.`));
    return;
  }

  console.log(chalk.yellow(`\n Deleting preset: ${preset.label}`));
  console.log(chalk.gray(`   Description: ${preset.description}`));
  console.log(chalk.gray(`   Components: ${preset.components.length}`));
  console.log();

  const confirmDelete = await confirm({
    message: `Are you sure you want to delete "${preset.label}"?`,
    initialValue: false,
  });

  if (isCancel(confirmDelete) || !confirmDelete) {
    outro(chalk.yellow("Deletion cancelled"));
    return;
  }

  try {
    deleteCustomPreset(presetName);
    outro(chalk.green(` Preset "${preset.label}" deleted successfully!`));
  } catch (error) {
    console.error(chalk.red("Deletion error:"), error);
    outro(chalk.red(" Failed to delete preset."));
  }
}
