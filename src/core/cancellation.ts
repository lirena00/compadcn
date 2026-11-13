export class CommandCancelled extends Error {
  constructor(message = "Operation cancelled before changing project files.") {
    super(message);
    this.name = "CommandCancelled";
  }
}
