import { text, multiselect, isCancel, note } from "@clack/prompts";
import chalk from "chalk";
import { saveCustomPreset } from "./presetStorage.js";
import { allComponents } from "@/lib/components.js";

export const createCustomPresetFlow = async (
  selectedComponents: string[]
): Promise<string | null> => {
  const presetName = await text({
    message: "Enter a name for your preset:",
    placeholder: "My Custom Preset",
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "Preset name is required";
      }
      if (value.trim().length < 3) {
        return "Preset name must be at least 3 characters long";
      }
      return undefined;
    },
  });

  if (isCancel(presetName)) {
    return null;
  }

  // Get preset description
  const presetDescription = await text({
    message: "Enter a description for your preset:",
    placeholder: "A collection of components for...",
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "Description is required";
      }
      return undefined;
    },
  });

  if (isCancel(presetDescription)) {
    return null;
  }

  // Generate a unique ID
  const presetId = `custom_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  // Get component objects for the selected values
  const componentObjects = allComponents.filter((comp) =>
    selectedComponents!.includes(comp.value)
  );

  // Save the preset
  try {
    saveCustomPreset(
      presetId,
      presetName as string,
      presetDescription as string,
      componentObjects
    );

    note(
      `${chalk.gray("Name:")} ${presetName}
${chalk.gray("Components:")} ${componentObjects.length}
${chalk.gray("ID:")} ${presetId}`
    );

    return presetId;
  } catch (error) {
    note(chalk.red("Failed to save custom preset"), "Error");
    return null;
  }
};
