import type { ZodRawShape } from "zod";
import type { CkanClient } from "../ckan/client.js";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";

export interface ToolContext {
  ckan: CkanClient;
  config: Config;
  log: Logger;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  /** Returns the JSON string payload for the tool result. */
  handler(args: Record<string, unknown>): Promise<string>;
}

export type ToolFactory = (ctx: ToolContext) => ToolDef;
