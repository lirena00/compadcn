import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { Preset } from "../lib/presets_config.js";
import { CliError, toCliError } from "../core/errors.js";

const CONFIG_DIR = join(homedir(), ".compadcn");
const PRESETS_FILE = join(CONFIG_DIR, "custom-presets.json");

export interface CustomPreset extends Preset {
  id: string;
  createdAt: string;
}

export interface CustomPresetsData {
  presets: Record<string, CustomPreset>;
}

export const ensureConfigDir = (): void => {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
};

export const loadCustomPresets = (): CustomPresetsData => {
  if (!existsSync(PRESETS_FILE)) {
    return { presets: {} };
  }

  try {
    const data = readFileSync(PRESETS_FILE, "utf-8");
    const parsed = JSON.parse(data) as CustomPresetsData;
    if (!parsed || !parsed.presets || typeof parsed.presets !== "object" || Array.isArray(parsed.presets)) {
      throw new CliError("PRESET_STORAGE_INVALID", "Custom preset storage must contain a presets object.");
    }
    for (const preset of Object.values(parsed.presets)) {
      if (!preset || typeof preset.label !== "string" || typeof preset.description !== "string" ||
        !Array.isArray(preset.components) || preset.components.some((component) =>
          !component || typeof component.label !== "string" || typeof component.value !== "string")) {
        throw new CliError("PRESET_STORAGE_INVALID", "Custom preset storage contains an invalid preset.");
      }
    }
    return parsed;
  } catch (error) {
    throw toCliError(error, "PRESET_STORAGE_INVALID", "Could not read custom preset storage.");
  }
};

export const saveCustomPreset = (
  id: string,
  label: string,
  description: string,
  components: Array<{
    label: string;
    value: string;
    dependencies?: string[];
    internal_dependencies?: string[];
  }>
): void => {
  ensureConfigDir();

  const customPresets = loadCustomPresets();

  customPresets.presets[id] = {
    id,
    label,
    description,
    components: components.map((comp) => ({
      ...comp,
      dependencies: comp.dependencies || [],
      internal_dependencies: comp.internal_dependencies || [],
    })),
    createdAt: new Date().toISOString(),
  };

  writeFileSync(PRESETS_FILE, JSON.stringify(customPresets, null, 2));
};

export const deleteCustomPreset = (id: string): void => {
  const customPresets = loadCustomPresets();
  if (!Object.hasOwn(customPresets.presets, id)) {
    throw new CliError("PRESET_NOT_FOUND", `Custom preset "${id}" not found.`);
  }
  delete customPresets.presets[id];
  writeFileSync(PRESETS_FILE, JSON.stringify(customPresets, null, 2));
};

export const getAllPresets = async (): Promise<{
  builtin: any;
  custom: CustomPresetsData;
}> => {
  const { presets: builtinPresets } = await import("../lib/presets_config.js");
  const customPresets = loadCustomPresets();

  return {
    builtin: builtinPresets,
    custom: customPresets,
  };
};
