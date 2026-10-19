import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CkanClient } from "./ckan/client.js";
import { loadConfig } from "./config.js";
import { createServer, type ServerDeps } from "./server.js";
import { createLogger } from "./util/logger.js";

// JSON-RPC requests from MCP clients are small; anything bigger is abuse.
const MAX_BODY_BYTES = 1_000_000;

class PayloadTooLargeError extends Error {}

/**
 * Streamable HTTP transport in stateless mode: every POST /mcp gets a fresh
 * McpServer + transport, so no session state lives on the box. The CKAN
 * client (and its LRU cache) is shared across requests.
 */
export function createHttpApp(deps: ServerDeps = {}): Server {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? createLogger(config);
  const ckan = deps.ckan ?? new CkanClient(config, log);

  return createNodeServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error("http handler failed", { message: (err as Error).message });
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
      return;
    }
    // Stateless: no SSE stream to resume (GET) and no session to end (DELETE).
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJsonRpcError(res, 405, -32000, "Method not allowed");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJsonRpcError(res, 413, -32600, "Request body too large");
      } else {
        sendJsonRpcError(res, 400, -32700, "Parse error");
      }
      return;
    }

    const server = createServer({ config, log, ckan });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  // Reject declared oversize bodies before reading, so the client gets a 413
  // instead of a reset socket.
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return Promise.reject(new PayloadTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
