#!/usr/bin/env node

import { Command } from "commander";
import { renderTitle } from "./utils/renderTitle.js";
import { runPresetUI } from "./commands/preset.js";
import { runInitUI } from "./commands/init.js";
import { runLintUI } from "./commands/lint.js";

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
  .command("init")
  .description("Initialize a new project with ShadCN components")
  .action(runInitUI);

program.parse(process.argv);
