export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly exitCode: number = 2
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function toCliError(error: unknown, code: string, message: string): CliError {
  if (error instanceof CliError) return error;
  return new CliError(code, error instanceof Error ? `${message} ${error.message}` : message);
}
