import { z } from "zod";

/**
 * Runtime configuration, sourced from environment variables.
 *
 * Phase 1 is read-only: no API token is read or stored. The write seam in
 * server.ts stays unwired until a later phase adds DATA_GOV_UA_API_TOKEN.
 */
const schema = z.object({
  // Canonical base. Live-verified to behave identically to the older
  // https://opendata.gov.ua/uk_UA/api/3/action default shipped in PLAN.md.
  baseUrl: z
    .string()
    .url()
    .default("https://data.gov.ua/api/3/action")
    .transform((u) => u.replace(/\/+$/, "")),
  userAgent: z
    .string()
    .default("opendata-mcp/0.1.0 (+https://github.com/opendata-ua/opendata-mcp)"),
  cacheTtlSeconds: z.coerce.number().int().min(0).default(300),
  httpTimeoutMs: z.coerce.number().int().min(1000).default(30_000),
  // Hard ceiling for any single tool response payload (chars of JSON).
  maxResponseChars: z.coerce.number().int().min(1000).default(60_000),
  // Cap for bytes we will download + parse locally in get_dataset_data.
  maxDownloadBytes: z.coerce.number().int().min(1024).default(10_000_000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // HTTP transport only (dist/http.js). Loopback by default — opt in to
  // network exposure with MCP_HTTP_HOST=0.0.0.0.
  httpHost: z.string().default("127.0.0.1"),
  httpPort: z.coerce.number().int().min(0).max(65535).default(3000),
  // Local full copies of flagship registries (dist/sync.js). Unset = no
  // lookup_record tool; set on servers that run the sync timer.
  mirrorDir: z.string().min(1).optional(),
  // Deadline for one tool invocation (download + parse + every upstream call).
  toolTimeoutMs: z.coerce.number().int().min(1000).default(60_000),
  // Tool calls running at once per process, and how many may wait; beyond
  // that the client gets "busy" instead of the box running out of memory.
  maxConcurrentTools: z.coerce.number().int().min(1).default(8),
  maxQueuedTools: z.coerce.number().int().min(0).default(32),
  // Simultaneous requests to data.gov.ua (shared egress IP, portal 429s).
  maxConcurrentUpstream: z.coerce.number().int().min(1).default(6),
  // HTTP transport: requests per minute per client IP (0 = unlimited).
  rateLimitPerMinute: z.coerce.number().int().min(0).default(120),
  // HTTP transport: optional shared secret; when set, POST /mcp requires
  // "Authorization: Bearer <token>". Unset = open access (private network).
  authToken: z.string().min(16).optional(),
  // HTTP transport: accepted Host header values (DNS-rebinding guard),
  // comma-separated. Unset = any host.
  allowedHosts: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean)
        : undefined,
    ),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse({
    baseUrl: env.DATA_GOV_UA_BASE_URL,
    userAgent: env.DATA_GOV_UA_USER_AGENT,
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    httpTimeoutMs: env.HTTP_TIMEOUT_MS,
    maxResponseChars: env.MAX_RESPONSE_CHARS,
    maxDownloadBytes: env.MAX_DOWNLOAD_BYTES,
    logLevel: env.LOG_LEVEL,
    httpHost: env.MCP_HTTP_HOST,
    httpPort: env.MCP_HTTP_PORT,
    mirrorDir: env.MIRROR_DIR || undefined,
    toolTimeoutMs: env.TOOL_TIMEOUT_MS,
    maxConcurrentTools: env.MAX_CONCURRENT_TOOLS,
    maxQueuedTools: env.MAX_QUEUED_TOOLS,
    maxConcurrentUpstream: env.MAX_CONCURRENT_UPSTREAM,
    rateLimitPerMinute: env.MCP_RATE_LIMIT_PER_MINUTE,
    authToken: env.MCP_AUTH_TOKEN || undefined,
    allowedHosts: env.MCP_ALLOWED_HOSTS || undefined,
  });
}
