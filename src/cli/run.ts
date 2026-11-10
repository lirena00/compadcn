import { CommanderError } from "commander";
import { createProgram } from "./create-program.js";
import { CliError } from "../core/errors.js";
import { packageInfo } from "../lib/packageInfo.js";
import {
  CliOutput,
  getOutputMode,
  type OutputOptions,
  validateOutputOptions,
} from "./output.js";

export async function runCli(argv: string[] = process.argv): Promise<number> {
  let information = "";
  const program = createProgram({
    writeInformation: (text) => { information += text; },
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    const options = program.opts<OutputOptions>();
    const output = new CliOutput(getOutputMode(options));

    try {
      validateOutputOptions(options);
    } catch (invalidOptions) {
      error = invalidOptions;
    }

    if (error instanceof CommanderError && error.exitCode === 0) {
      output.success(
        error.code === "commander.version"
          ? { name: packageInfo.name, version: packageInfo.version }
          : { help: information.trimEnd() },
        information
      );
      return 0;
    }

    const failure = error instanceof CliError
      ? error
      : error instanceof CommanderError
        ? new CliError("INVALID_ARGUMENT", error.message.replace(/^error: /, ""), {
            parserCode: error.code,
          })
        : new CliError(
            "COMMAND_FAILED",
            error instanceof Error ? error.message : "An unexpected error occurred."
          );
    output.error(failure);
    return failure.exitCode;
  }
}
