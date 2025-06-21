#!/usr/bin/env node

import { Command } from "commander";
import { runPresetUI } from "./commands/preset.js";
import { runAddUI } from "./commands/add.js";
import { runLintUI } from "./commands/lint.js";
import { runRemoveUI } from "./commands/remove.js";
const program = new Command();

program
  .name("compadcn")
  .description("CLI for installing and managing ShadCN UI components")
  .version("0.0.1");
// .action(renderTitle);

program
  .command("preset")
  .description("Launch interactive TUI to select components")
  .action(runPresetUI);

program
  .command("lint")
  .description("Initialize a new project with ShadCN components")
  .action(runLintUI);

program
  .command("add")
  .description("Initialize a new project with ShadCN components")
  .argument("[components...]", "Component names to add (e.g., button card)")
  .action((components: string[]) => runAddUI(components));

program
  .command("remove")
  .description("Remove ShadCN UI components from your project")
  .argument("[components...]", "Component names to remove (e.g., button card)")
  .action((components: string[]) => runRemoveUI(components));

program.parse(process.argv);
