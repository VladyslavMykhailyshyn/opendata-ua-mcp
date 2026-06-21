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
  userAgent: z.string().default("opendata-mcp/0.1.0 (+https://github.com/opendata-ua/opendata-mcp)"),
  cacheTtlSeconds: z.coerce.number().int().min(0).default(300),
  httpTimeoutMs: z.coerce.number().int().min(1000).default(30_000),
  // Hard ceiling for any single tool response payload (chars of JSON).
  maxResponseChars: z.coerce.number().int().min(1000).default(60_000),
  // Cap for bytes we will download + parse locally in get_dataset_data.
  maxDownloadBytes: z.coerce.number().int().min(1024).default(10_000_000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
  });
}
