import { Command } from "commander";
import { packageInfo } from "../lib/packageInfo.js";
import { CliError } from "../core/errors.js";
import { type OutputOptions, validateOutputOptions } from "./output.js";

export interface ProgramOptions {
  writeInformation?: (text: string) => void;
}

export function createProgram(options: ProgramOptions = {}): Command {
  const program = new Command()
    .name(packageInfo.name)
    .description(packageInfo.description)
    .version(packageInfo.version)
    .option("--json", "Output structured JSON for supported commands")
    .option("--plain", "Output plain text for supported commands")
    .option("--no-interactive", "Disable interactive prompts")
    .exitOverride()
    .configureOutput({
      writeOut: options.writeInformation ?? ((text) => process.stdout.write(text)),
      // The runner renders parser errors using the selected output contract.
      writeErr: () => {},
      outputError: () => {},
    });

  program.action(() => program.help());

  program.hook("preAction", async (_program, command) => {
    const outputOptions = program.opts<OutputOptions>();
    validateOutputOptions(outputOptions);
    if (command === program) return;

    if (outputOptions.json || outputOptions.plain) {
      throw new CliError(
        "OUTPUT_MODE_UNSUPPORTED",
        "This legacy workflow does not support --json or --plain yet. " +
          "Help and version output support both modes."
      );
    }

    const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
      outputOptions.interactive !== false;
    const isReadOnlyPreset = command.parent?.name() === "preset" &&
      ["list", "show"].includes(command.name());

    if (!canPrompt && !isReadOnlyPreset) {
      throw new CliError(
        "INTERACTIVE_REQUIRED",
        "This legacy workflow requires an interactive terminal. " +
          "Run it in a terminal without --no-interactive."
      );
    }

    if (canPrompt) {
      const { renderTitle } = await import("../utils/renderTitle.js");
      renderTitle();
    }
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
