/** An error whose message is safe to show to end users. */
export class ToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
