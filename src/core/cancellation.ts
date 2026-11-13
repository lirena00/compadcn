export class CommandCancelled extends Error {
  constructor(message = "Operation cancelled.") {
    super(message);
    this.name = "CommandCancelled";
  }
}
