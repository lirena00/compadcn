#!/usr/bin/env node

import { Command } from "commander";
import { renderTitle } from "./utils/renderTitle.js";
import { runPresetUI } from "./commands/preset.js";

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

program.parse(process.argv);
