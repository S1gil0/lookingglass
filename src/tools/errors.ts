export class ToolPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPreflightError";
  }
}