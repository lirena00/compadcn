import { CliError } from "../core/errors.js";
import { packageInfo } from "../lib/packageInfo.js";
import type { CommandFailure, CommandSuccess } from "../core/results.js";

export type OutputMode = "interactive" | "plain" | "json";

export interface OutputOptions {
  json?: boolean;
  plain?: boolean;
  interactive?: boolean;
}

export interface OutputWriter {
  write(text: string): unknown;
}

export function getOutputMode(
  options: OutputOptions,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
): OutputMode {
  if (options.json) return "json";
  if (options.plain || options.interactive === false || !isTTY) return "plain";
  return "interactive";
}

export function validateOutputOptions(options: OutputOptions): void {
  if (options.json && options.plain) {
    throw new CliError("INVALID_OPTIONS", "Use either --json or --plain, not both.");
  }
}

export class CliOutput {
  constructor(
    readonly mode: OutputMode,
    private readonly stdout: OutputWriter = process.stdout,
    private readonly stderr: OutputWriter = process.stderr
  ) {}

  success<T>(data: T, text: string): void {
    if (this.mode === "json") {
      const result: CommandSuccess<T> = {
        schemaVersion: 1,
        toolVersion: packageInfo.version,
        status: "completed",
        data,
      };
      this.stdout.write(JSON.stringify(result) + "\n");
    } else {
      this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  }

  error(error: CliError): void {
    if (this.mode === "json") {
      const result: CommandFailure = {
        schemaVersion: 1,
        toolVersion: packageInfo.version,
        status: "error",
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      this.stdout.write(JSON.stringify(result) + "\n");
    } else {
      this.stderr.write(`ERROR ${error.code}: ${error.message}\n`);
    }
  }
}
