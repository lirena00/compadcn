import { presets } from "../lib/presets_config.js";
import { loadCustomPresets } from "../utils/presetStorage.js";

export async function getAllPresets() {
  const builtinPresets = Object.entries(presets.presets).map(
    ([id, preset]) => ({
      id,
      label: preset.label,
      description: preset.description,
      components: preset.components,
      isCustom: false,
    })
  );

  const customPresets = Object.entries(loadCustomPresets().presets).map(
    ([id, preset]) => ({
      id,
      label: preset.label,
      description: preset.description,
      components: preset.components,
      isCustom: true,
    })
  );

  return [...builtinPresets, ...customPresets];
}
