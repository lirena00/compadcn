import { Command } from "commander";
import { packageInfo } from "../lib/packageInfo.js";

export function createProgram(): Command {
  const program = new Command()
    .name(packageInfo.name)
    .description(packageInfo.description)
    .version(packageInfo.version);

  program.hook("preAction", async () => {
    const { renderTitle } = await import("../utils/renderTitle.js");
    renderTitle();
  });

  const presetCommand = program
    .command("preset")
    .alias("p")
    .description("Manage component presets")
    .action(async () => {
      const { runPresetUI } = await import("../commands/preset.js");
      await runPresetUI();
    });

  presetCommand
    .command("list")
    .alias("ls")
    .description("List all available presets")
    .option("-b, --builtin", "Show only builtin presets")
    .option("-c, --custom", "Show only custom presets")
    .action(async (options) => {
      const { listPresets } = await import("../commands/presetCommands.js");
      await listPresets(options);
    });

  presetCommand
    .command("show <preset_name>")
    .alias("s")
    .description("Show components in a preset")
    .action(async (presetName: string) => {
      const { showPreset } = await import("../commands/presetCommands.js");
      await showPreset(presetName);
    });

  presetCommand
    .command("install <preset_name>")
    .alias("i")
    .description("Install all components from a preset")
    .action(async (presetName: string) => {
      const { installPreset } = await import("../commands/presetCommands.js");
      await installPreset(presetName);
    });

  presetCommand
    .command("create <preset_name> [components...]")
    .alias("c")
    .description("Create a new custom preset")
    .option("-d, --description <description>", "Preset description")
    .option("-b, --base <preset_names>", "Base presets to extend (comma-separated)")
    .action(async (presetName: string, components: string[], options) => {
      const { createPreset } = await import("../commands/presetCommands.js");
      await createPreset(presetName, components, options);
    });

  presetCommand
    .command("delete <preset_name>")
    .alias("del")
    .description("Delete a custom preset")
    .action(async (presetName: string) => {
      const { deletePreset } = await import("../commands/presetCommands.js");
      await deletePreset(presetName);
    });

  program
    .command("lint")
    .alias("l")
    .description("Find unused ShadCN components")
    .action(async () => {
      const { runLintUI } = await import("../commands/lint.js");
      await runLintUI();
    });

  program
    .command("add")
    .alias("a")
    .description("Add ShadCN components to your project")
    .option("-o, --overwrite", "Overwrite existing files")
    .option("--css-variables", "Use CSS variables for theming (default)")
    .option("--no-css-variables", "Do not use CSS variables for theming")
    .argument("[components...]", "Component names to add (e.g., button card)")
    .action(async (components: string[], options) => {
      const { runAddUI } = await import("../commands/add.js");
      await runAddUI(components, options);
    });

  program
    .command("remove")
    .alias("rm")
    .description("Remove ShadCN UI components from your project")
    .argument("[components...]", "Component names to remove (e.g., button card)")
    .action(async (components: string[]) => {
      const { runRemoveUI } = await import("../commands/remove.js");
      await runRemoveUI(components);
    });

  return program;
}
