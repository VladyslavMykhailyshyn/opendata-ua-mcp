import type { ZodRawShape } from "zod";
import type { CkanClient } from "../ckan/client.js";
import type { Config } from "../config.js";
import type { MirrorReader } from "../mirror/store.js";
import type { Logger } from "../util/logger.js";

export interface ToolContext {
  ckan: CkanClient;
  config: Config;
  log: Logger;
  /** One per process (shared SQLite handles). Set only when MIRROR_DIR is configured. */
  mirror?: MirrorReader;
}

/** Per-invocation state. `signal` fires on client disconnect or tool deadline. */
export interface ToolCall {
  signal: AbortSignal;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  /** Returns the JSON string payload for the tool result. */
  handler(args: Record<string, unknown>, call: ToolCall): Promise<string>;
}

export type ToolFactory = (ctx: ToolContext) => ToolDef;
