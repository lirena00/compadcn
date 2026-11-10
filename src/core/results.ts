export interface CommandSuccess<T> {
  schemaVersion: 1;
  toolVersion: string;
  status: "completed";
  data: T;
}

export interface CommandFailure {
  schemaVersion: 1;
  toolVersion: string;
  status: "error";
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CommandResult<T> = CommandSuccess<T> | CommandFailure;
