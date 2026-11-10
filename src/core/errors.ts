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

export function toCliError(error: unknown, code: string, message: string): CliError {
  if (error instanceof CliError) return error;
  return new CliError(code, error instanceof Error ? `${message} ${error.message}` : message);
}
