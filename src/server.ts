import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CkanClient } from "./ckan/client.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./util/logger.js";
import { CkanError } from "./ckan/errors.js";
import { ToolError, isAbortError } from "./util/errors.js";
import { Semaphore } from "./util/semaphore.js";
import { MirrorReader } from "./mirror/store.js";
import type { ToolContext, ToolFactory } from "./tools/types.js";
import { findDatasets } from "./tools/find-datasets.js";
import { exploreCatalog } from "./tools/explore-catalog.js";
import { inspectDataset } from "./tools/inspect-dataset.js";
import { getDatasetData } from "./tools/get-dataset-data.js";
import { filterData } from "./tools/filter-data.js";
import { trackUpdates } from "./tools/track-updates.js";
import { lookupRecord } from "./tools/lookup-record.js";

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
  /** Shared across requests; created by the HTTP app or stdio entry. */
  mirror?: MirrorReader;
  /** Process-wide cap on tool calls in flight. */
  limiter?: Semaphore;
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? createLogger(config);
  const ckan = deps.ckan ?? new CkanClient(config, log);
  const limiter = deps.limiter ?? new Semaphore(config.maxConcurrentTools, config.maxQueuedTools);
  // stdio and tests: one server per process, so owning the reader here is fine.
  // The HTTP app creates a server per request and must pass its shared reader.
  const mirror = deps.mirror ?? (config.mirrorDir ? new MirrorReader(config.mirrorDir) : undefined);
  const ctx: ToolContext = { ckan, config, log, mirror };

  const server = new McpServer({
    name: "opendata-ua-mcp",
    version: "0.1.0",
  });

  registerReadTools(
    server,
    ctx,
    limiter,
    mirror ? [...READ_TOOLS, lookupRecord] : READ_TOOLS,
  );
  // Write seam: a future phase calls registerWriteTools(server, ctx) when a
  // DATA_GOV_UA_API_TOKEN is configured. Intentionally unwired in Phase 1.

  return server;
}

function registerReadTools(
  server: McpServer,
  ctx: ToolContext,
  limiter: Semaphore,
  tools: ToolFactory[],
): void {
  for (const factory of tools) {
    const tool = factory(ctx);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>, extra) => {
        // Every call stops when the client goes away or the deadline passes;
        // the limiter keeps a burst of heavy calls from exhausting the box.
        const deadline = AbortSignal.timeout(ctx.config.toolTimeoutMs);
        const signal = extra.signal ? AbortSignal.any([extra.signal, deadline]) : deadline;
        const started = Date.now();
        try {
          const text = await limiter.run(() => tool.handler(args, { signal }), signal);
          ctx.log.debug("tool ok", { tool: tool.name, ms: Date.now() - started });
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const message = clientMessage(err, signal);
          ctx.log.error("tool error", {
            tool: tool.name,
            ms: Date.now() - started,
            message: (err as Error).message,
            ...(message.startsWith("Внутрішня") ? { stack: (err as Error).stack } : {}),
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
            isError: true,
          };
        }
      },
    );
  }
}

/** Only errors we classify as safe reach the client verbatim. */
function clientMessage(err: unknown, signal: AbortSignal): string {
  if (err instanceof CkanError) return `${err.name}: ${err.message}`;
  if (err instanceof ToolError) return err.message;
  if (signal.aborted || isAbortError(err)) {
    return "Перевищено час виконання запиту або клієнт розірвав з'єднання.";
  }
  return "Внутрішня помилка сервера.";
}
