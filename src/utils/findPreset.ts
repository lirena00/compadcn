import { presets, type Preset } from "../lib/presets_config.js";
import { loadCustomPresets } from "./presetStorage";

export async function findPreset(
  presetName: string
): Promise<
  (Preset & { id?: string; isCustom?: boolean; createdAt?: string }) | null
> {
  const builtinPresets = presets.presets;

  // Check builtin presets by ID
  if (builtinPresets[presetName]) {
    return {
      ...builtinPresets[presetName],
      id: presetName,
      isCustom: false,
    };
  }

  // Check builtin presets by label
  const builtinEntry = Object.entries(builtinPresets).find(
    ([id, preset]) => preset.label.toLowerCase() === presetName.toLowerCase()
  );
  if (builtinEntry) {
    return {
      ...builtinEntry[1],
      id: builtinEntry[0],
      isCustom: false,
    };
  }

  const customPresets = loadCustomPresets();

  // Check custom presets by ID
  if (customPresets.presets[presetName]) {
    return {
      ...customPresets.presets[presetName],
      id: presetName,
      isCustom: true,
    };
  }

  // Check custom presets by label
  const customEntry = Object.entries(customPresets.presets).find(
    ([id, preset]) => preset.label.toLowerCase() === presetName.toLowerCase()
  );
  if (customEntry) {
    return {
      ...customEntry[1],
      id: customEntry[0],
      isCustom: true,
    };
  }

  return null;
}
