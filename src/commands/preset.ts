import {
  intro,
  outro,
  select,
  text,
  multiselect,
  confirm,
  isCancel,
  note,
} from "@clack/prompts";
import chalk from "chalk";
import { loadCustomPresets } from "../utils/presetStorage.js";
import { getAllPresets } from "../utils/getAllPresets.js";

import {
  listPresets,
  showPreset,
  installPreset,
  createPreset,
  deletePreset,
} from "./presetCommands.js";

export async function runPresetUI() {
  intro(chalk.bgCyan("Preset Manager"));

  const action = await select({
    message: "What would you like to do?",
    options: [
      {
        value: "install",
        label: "Install a preset",
      },
      {
        value: "list",
        label: "List all presets",
      },
      {
        value: "show",
        label: "Show preset details",
      },
      {
        value: "create",
        label: "Create custom preset",
      },
      {
        value: "delete",
        label: "Delete custom preset",
      },
    ],
  });

  if (isCancel(action)) {
    outro(chalk.yellow("Operation cancelled"));
    return;
  }

  switch (action) {
    case "install":
      await handleInstallPreset();
      break;
    case "list":
      await handleListPresets();
      break;
    case "show":
      await handleShowPreset();
      break;
    case "create":
      await handleCreatePreset();
      break;
    case "delete":
      await handleDeletePreset();
      break;
  }
}

async function handleInstallPreset() {
  const allPresets = await getAllPresets();

  const selectedPreset = await select({
    message: "Which preset would you like to install?",
    options: allPresets.map((preset) => ({
      value: preset.id,
      label: `${preset.label} ${
        preset.isCustom ? chalk.cyan("(custom)") : chalk.green("(builtin)")
      }`,
      hint: `${preset.description} • ${preset.components.length} components`,
    })),
  });

  if (isCancel(selectedPreset)) {
    outro(chalk.yellow("Installation cancelled"));
    return;
  }

  await installPreset(selectedPreset);
}

async function handleListPresets() {
  const filterType = await select({
    message: "Which presets would you like to see?",
    options: [
      {
        value: "all",
        label: "All presets",
        hint: "Show both builtin and custom",
      },
      {
        value: "builtin",
        label: "Builtin presets only",
        hint: "Show only builtin presets",
      },
      {
        value: "custom",
        label: "Custom presets only",
        hint: "Show only your custom presets",
      },
    ],
  });

  if (isCancel(filterType)) {
    outro(chalk.yellow("Operation cancelled"));
    return;
  }

  const options: any = {};
  if (filterType === "builtin") options.builtin = true;
  if (filterType === "custom") options.custom = true;

  await listPresets(options);
}

async function handleShowPreset() {
  const allPresets = await getAllPresets();

  const selectedPreset = await select({
    message: "Which preset would you like to view?",
    options: allPresets.map((preset) => ({
      value: preset.id,
      label: `${preset.label} ${
        preset.isCustom ? chalk.cyan("(custom)") : chalk.green("(builtin)")
      }`,
      hint: preset.description,
    })),
  });

  if (isCancel(selectedPreset)) {
    outro(chalk.yellow("Operation cancelled"));
    return;
  }

  await showPreset(selectedPreset);
}

async function handleCreatePreset() {
  const presetName = await text({
    message: "What should we call your preset?",
    placeholder: "my-awesome-preset",
    validate: (value) => {
      if (!value) return "Preset name is required";
      if (value.length < 3) return "Preset name must be at least 3 characters";
      if (!/^[a-zA-Z0-9-_\s]+$/.test(value))
        return "Only letters, numbers, hyphens, underscores, and spaces allowed";
      return;
    },
  });

  if (isCancel(presetName)) {
    outro(chalk.yellow("Creation cancelled"));
    return;
  }

  // Ask if they want to base it on an existing preset
  const useBase = await confirm({
    message: "Do you want to base this on an existing preset?",
    initialValue: false,
  });

  if (isCancel(useBase)) {
    outro(chalk.yellow("Creation cancelled"));
    return;
  }

  let basePreset = null;
  if (useBase) {
    const allPresets = await import("../utils/getAllPresets.js").then((m) =>
      m.getAllPresets()
    );

    const selectedBase = await select({
      message: "Which preset should we use as the base?",
      options: allPresets.map((preset) => ({
        value: preset.id,
        label: `${preset.label} ${
          preset.isCustom ? chalk.cyan("(custom)") : chalk.green("(builtin)")
        }`,
        hint: `${preset.description} • ${preset.components.length} components`,
      })),
    });

    if (isCancel(selectedBase)) {
      outro(chalk.yellow("Creation cancelled"));
      return;
    }

    basePreset = selectedBase;
  }

  const description = await text({
    message: "Add a description (optional)",
    placeholder: basePreset
      ? `A preset based on ${basePreset}`
      : "A preset for my project components",
  });

  if (isCancel(description)) {
    outro(chalk.yellow("Creation cancelled"));
    return;
  }

  const { allComponents } = await import("../lib/components.js");

  // Get base components if a base preset was selected
  let initialValues: string[] = [];
  if (basePreset) {
    const { findPreset } = await import("../utils/findPreset.js");
    const preset = await findPreset(basePreset);
    if (preset) {
      initialValues = preset.components.map((comp) => comp.value);
    }
  }
  const selectedComponents = await multiselect({
    message: basePreset
      ? "Select components for your preset (base components are pre-selected)"
      : "Select components for your preset",
    options: allComponents.map((comp) => ({
      value: comp.value,
      label: comp.label,
      hint: comp.value,
    })),
    required: true,
    initialValues,
  });

  if (isCancel(selectedComponents)) {
    outro(chalk.yellow("Creation cancelled"));
    return;
  }

  try {
    await createPreset(presetName, selectedComponents, {
      description: description || undefined,
      base: basePreset || undefined,
    });
    outro(chalk.green("Preset created successfully!"));
  } catch (error) {
    console.error(chalk.red("Error creating preset:"), error);
    outro(chalk.red("Failed to create preset. Please check the error above."));
  }
}

async function handleDeletePreset() {
  const customPresets = loadCustomPresets();
  const customPresetEntries = Object.entries(customPresets.presets);

  if (customPresetEntries.length === 0) {
    outro(chalk.yellow("No custom presets found to delete"));
    return;
  }

  const selectedPreset = await select({
    message: "Which custom preset would you like to delete?",
    options: customPresetEntries.map(([id, preset]) => ({
      value: id,
      label: preset.label,
      hint: `${preset.description} • ${preset.components.length} components`,
    })),
  });

  if (isCancel(selectedPreset)) {
    outro(chalk.yellow("Deletion cancelled"));
    return;
  }

  await deletePreset(selectedPreset);
}
