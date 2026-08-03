export class ToolPreflightError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ToolPreflightError";
    this.code = code;
  }
}