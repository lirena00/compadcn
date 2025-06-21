import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { Preset } from "../lib/presets_config.js";

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
  ensureConfigDir();

  if (!existsSync(PRESETS_FILE)) {
    return { presets: {} };
  }

  try {
    const data = readFileSync(PRESETS_FILE, "utf-8");
    return JSON.parse(data) as CustomPresetsData;
  } catch (error) {
    console.warn("Failed to load custom presets, starting with empty config");
    return { presets: {} };
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
