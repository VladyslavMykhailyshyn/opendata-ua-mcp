import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CkanClient } from "./ckan/client.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./util/logger.js";
import { CkanError } from "./ckan/errors.js";
import type { ToolContext, ToolFactory } from "./tools/types.js";
import { findDatasets } from "./tools/find-datasets.js";
import { exploreCatalog } from "./tools/explore-catalog.js";
import { inspectDataset } from "./tools/inspect-dataset.js";
import { getDatasetData } from "./tools/get-dataset-data.js";
import { filterData } from "./tools/filter-data.js";
import { trackUpdates } from "./tools/track-updates.js";

const READ_TOOLS: ToolFactory[] = [
  findDatasets,
  exploreCatalog,
  inspectDataset,
  getDatasetData,
  filterData,
  trackUpdates,
];

export interface ServerDeps {
  config?: Config;
  log?: Logger;
  ckan?: CkanClient;
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? createLogger(config);
  const ckan = deps.ckan ?? new CkanClient(config, log);
  const ctx: ToolContext = { ckan, config, log };

  const server = new McpServer({
    name: "opendata-ua-mcp",
    version: "0.1.0",
  });

  registerReadTools(server, ctx);
  // Write seam: a future phase calls registerWriteTools(server, ctx) when a
  // DATA_GOV_UA_API_TOKEN is configured. Intentionally unwired in Phase 1.

  return server;
}

function registerReadTools(server: McpServer, ctx: ToolContext): void {
  for (const factory of READ_TOOLS) {
    const tool = factory(ctx);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const text = await tool.handler(args);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const message =
            err instanceof CkanError
              ? `${err.name}: ${err.message}`
              : `Помилка: ${(err as Error).message}`;
          ctx.log.error("tool error", { tool: tool.name, message });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
            isError: true,
          };
        }
      },
    );
  }
}
