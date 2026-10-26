/**
 * An error whose message is safe to show to the MCP client. Anything else
 * thrown from a tool is logged in full and replaced by a generic message.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError" || err.message === "This operation was aborted")
  );
}
