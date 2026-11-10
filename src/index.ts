export { createProgram } from "./cli/create-program.js";
export { runCli } from "./cli/run.js";
export { packageInfo } from "./lib/packageInfo.js";
export { CliError } from "./core/errors.js";
export { CliOutput, getOutputMode } from "./cli/output.js";
export type { OutputMode, OutputOptions, OutputWriter } from "./cli/output.js";
export type { ProgramOptions } from "./cli/create-program.js";
export type { CommandSuccess, CommandFailure, CommandResult } from "./core/results.js";
