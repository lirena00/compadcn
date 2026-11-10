export class CliError extends Error {
  readonly exitCode = 2;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CliError";
  }
}
