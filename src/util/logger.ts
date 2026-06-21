import type { Config } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

// Redact anything that looks like an API token, even though Phase 1 sends none.
const SENSITIVE = /(authorization|api[_-]?token|x-ckan-api-key)/i;

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : v;
  }
  return out;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(config: Pick<Config, "logLevel">): Logger {
  const threshold = LEVELS[config.logLevel];
  // MCP stdio uses stdout for protocol traffic — logs MUST go to stderr.
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    const line = { level, msg, ...(meta ? redact(meta) : {}) };
    process.stderr.write(JSON.stringify(line) + "\n");
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
