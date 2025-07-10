#!/usr/bin/env node

import { Command, Option } from "commander";
import { renderTitle } from "./utils/renderTitle.js";
import { runPresetUI } from "./commands/preset.js";
import { runAddUI } from "./commands/add.js";
import { runLintUI } from "./commands/lint.js";
import { runRemoveUI } from "./commands/remove.js";
import {
  listPresets,
  showPreset,
  installPreset,
  createPreset,
  deletePreset,
} from "./commands/presetCommands.js";

const program = new Command();

program
  .name("compadcn")
  .description("CLI for installing and managing ShadCN UI components")
  .version("0.0.1");

program.hook("preAction", () => {
  renderTitle();
});

const presetCommand = program
  .command("preset")
  .alias("p")
  .description("Manage component presets");

presetCommand.action(runPresetUI);

presetCommand
  .command("list")
  .alias("ls")
  .description("List all available presets")
  .option("-b", "--builtin", "Show only builtin presets")
  .option("-c", "--custom", "Show only custom presets")
  .action(listPresets);

presetCommand
  .command("show <preset_name>")
  .alias("s")
  .description("Show components in a preset")
  .action((presetName) => showPreset(presetName));

presetCommand
  .command("install <preset_name>")
  .alias("i")
  .description("Install all components from a preset")
  .action((presetName) => installPreset(presetName));

presetCommand
  .command("create <preset_name> [components...]")
  .alias("c")
  .description("Create a new custom preset")
  .option("-d, --description <description>", "Preset description")
  .option(
    "-b, --base <preset_names>",
    "Base presets to extend from (comma-separated)"
  )
  .action((presetName, components, options) =>
    createPreset(presetName, components, options)
  );

presetCommand
  .command("delete <preset_name>")
  .alias("del")
  .description("Delete a custom preset")
  .action((presetName) => deletePreset(presetName));

program
  .command("lint")
  .alias("l")
  .description("Find unused ShadCN components")
  .action(runLintUI);

program
  .command("add")
  .alias("a")
  .option("-o, --overwrite", "Overwrite existing files")
  .option("--css-variables", "Use CSS variables for theming (default)")
  .option("--no-css-variables", "do not use css variables for theming")
  .description("Add ShadCN components to your project")
  .argument("[components...]", "Component names to add (e.g., button card)")
  .action((components: string[], options) => runAddUI(components, options));

program
  .command("remove")
  .alias("rm")
  .description("Remove ShadCN UI components from your project")
  .argument("[components...]", "Component names to remove (e.g., button card)")
  .action((components: string[]) => runRemoveUI(components));

program.parse(process.argv);
