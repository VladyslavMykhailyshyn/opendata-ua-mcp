import { timingSafeEqual } from "node:crypto";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CkanClient } from "./ckan/client.js";
import { loadConfig } from "./config.js";
import { MirrorReader } from "./mirror/store.js";
import { createServer, type ServerDeps } from "./server.js";
import { createLogger } from "./util/logger.js";
import { Semaphore } from "./util/semaphore.js";

// JSON-RPC requests from MCP clients are small; anything bigger is abuse.
const MAX_BODY_BYTES = 1_000_000;

// How long we keep reading an oversized streamed body before cutting it.
const DRAIN_GRACE_MS = 1_000;

class PayloadTooLargeError extends Error {
  /** True when the client was still streaming when we gave up draining. */
  constructor(readonly streaming: boolean) {
    super("Request body too large");
  }
}

const draining = new WeakSet<Server>();

/**
 * Stop taking new work: /health answers 503 so a load balancer pulls the
 * instance, /mcp refuses new calls. Requests already in flight finish.
 */
export function drainHttpApp(server: Server): void {
  draining.add(server);
}

/**
 * Streamable HTTP transport in stateless mode: every POST /mcp gets a fresh
 * McpServer + transport, so no session state lives on the box. The CKAN
 * client (and its LRU cache) is shared across requests.
 */
export function createHttpApp(deps: ServerDeps = {}): Server {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? createLogger(config);
  const ckan = deps.ckan ?? new CkanClient(config, log);
  // Shared across every request: SQLite handles and the in-flight cap.
  const mirror = deps.mirror ?? (config.mirrorDir ? new MirrorReader(config.mirrorDir) : undefined);
  const limiter = deps.limiter ?? new Semaphore(config.maxConcurrentTools, config.maxQueuedTools);
  const rateLimiter =
    config.rateLimitPerMinute > 0 ? new RateLimiter(config.rateLimitPerMinute) : null;
  const allowedHosts = config.allowedHosts ? new Set(config.allowedHosts) : null;

  const app = createNodeServer(
    // Slowloris guards: headers and body must arrive promptly; idle keep-alive
    // sockets are dropped fast so a connection flood can't pin the box.
    { headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5_000 },
    (req, res) => {
      handle(req, res).catch((err: unknown) => {
        log.error("http handler failed", { message: (err as Error).message });
        if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
      });
    },
  );
  app.maxConnections = 512;
  app.maxRequestsPerSocket = 100;
  app.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => {
    // Malformed requests never reach the handler; answer and hang up quietly.
    if (err.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  app.on("close", () => mirror?.close());
  return app;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    const isDraining = draining.has(app);

    if (path === "/health") {
      if (isDraining) {
        res
          .writeHead(503, { "content-type": "application/json", connection: "close" })
          .end('{"status":"draining"}');
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      }
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
      return;
    }

    // One line per /mcp request; never the arguments or the body.
    const ip = req.socket.remoteAddress ?? "unknown";
    const started = Date.now();
    let rpcMethod: string | undefined;
    let tool: string | undefined;
    res.once("close", () => {
      log.info("http", {
        ip,
        status: res.statusCode,
        ms: Date.now() - started,
        ...(rpcMethod ? { method: rpcMethod } : {}),
        ...(tool ? { tool } : {}),
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });

    if (isDraining) {
      res.setHeader("connection", "close");
      sendJsonRpcError(res, 503, -32000, "Server is shutting down");
      return;
    }
    // DNS-rebinding guard: a browser-side attacker can't choose the Host header.
    if (allowedHosts && !allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
      sendJsonRpcError(res, 421, -32000, "Misdirected request");
      return;
    }
    // Stateless: no SSE stream to resume (GET) and no session to end (DELETE).
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJsonRpcError(res, 405, -32000, "Method not allowed");
      return;
    }
    // Before auth, so token guessing is throttled too.
    if (rateLimiter) {
      const wait = rateLimiter.take(ip);
      if (wait > 0) {
        res.setHeader("retry-after", String(wait));
        sendJsonRpcError(res, 429, -32000, "Too many requests");
        return;
      }
    }
    if (config.authToken && !authorized(req.headers.authorization, config.authToken)) {
      res.setHeader("www-authenticate", "Bearer");
      sendJsonRpcError(res, 401, -32000, "Unauthorized");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.setHeader("connection", "close");
        // A body that ended (or was declared) closes cleanly after the 413;
        // a stream still running after the grace period is cut.
        const onSent = err.streaming ? () => req.destroy() : undefined;
        sendJsonRpcError(res, 413, -32600, "Request body too large", onSent);
      } else {
        sendJsonRpcError(res, 400, -32700, "Parse error");
      }
      return;
    }
    // A batch would run up to 100 tool calls under one request's budget.
    if (Array.isArray(body)) {
      sendJsonRpcError(res, 400, -32600, "Batch requests are not supported");
      return;
    }
    if (isRecord(body)) {
      rpcMethod = typeof body.method === "string" ? body.method : undefined;
      const params = body.params;
      if (rpcMethod === "tools/call" && isRecord(params) && typeof params.name === "string") {
        tool = params.name;
      }
    }

    const server = createServer({ config, log, ckan, mirror, limiter });
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

/**
 * Token bucket per client IP: `perMinute` tokens, refilled continuously,
 * burst up to the same number. Idle buckets are pruned so the map stays bounded.
 */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMs: number;

  constructor(private readonly perMinute: number) {
    this.perMs = perMinute / 60_000;
  }

  /** Returns 0 when the request may proceed, else seconds until a token frees up. */
  take(key: string, now = Date.now()): number {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) this.prune(now);
      bucket = { tokens: this.perMinute, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.at) * this.perMs);
    bucket.at = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000));
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 300_000) this.buckets.delete(key);
    }
  }
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    // Keep reading so the socket can close cleanly after the 413: destroying
    // it with unread input sends a RST and the client never sees the answer.
    // An endless stream is cut after a short grace period. A declared
    // oversize body goes the same way: answering before the client has
    // finished sending races the close against its last packets.
    const drain = () => {
      overflow = true;
      chunks.length = 0;
      const cut = setTimeout(() => reject(new PayloadTooLargeError(true)), DRAIN_GRACE_MS);
      req.once("end", () => {
        clearTimeout(cut);
        reject(new PayloadTooLargeError(false));
      });
    };
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) drain();
    req.on("data", (chunk: Buffer) => {
      if (overflow) return; // draining
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }
      drain();
    });
    req.on("end", () => {
      if (!overflow) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  onSent?: () => void,
): void {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), onSent);
}
