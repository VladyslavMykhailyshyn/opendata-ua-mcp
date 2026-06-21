import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import { createCache } from "../util/cache.js";
import { CkanError, CkanServerError, toCkanError } from "./errors.js";

export interface CkanCallOptions {
  /** Force HTTP method. Default: GET. Some actions (datastore_info) require POST. */
  method?: "GET" | "POST";
  /** Cache idempotent reads (group_list, organization_list, license_list). */
  cache?: boolean;
  signal?: AbortSignal;
}

interface CkanEnvelope<T> {
  success: boolean;
  result?: T;
  error?: { __type?: string; message?: string | string[] };
}

const RETRYABLE = new Set([0, 429, 500, 502, 503, 504]);

/**
 * Thin CKAN Action API client. One public method `call`. Handles GET/POST,
 * the {success,result,error} envelope, typed errors, retry-with-backoff on
 * 5xx/network, Retry-After, and an LRU cache for idempotent calls.
 */
export class CkanClient {
  private readonly cache;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.cache = createCache<object>(config.cacheTtlSeconds);
  }

  async call<T>(
    action: string,
    params: Record<string, unknown> = {},
    opts: CkanCallOptions = {},
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const cacheKey = opts.cache ? `${action}:${JSON.stringify(params)}` : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) return hit as T;
    }

    const result = await this.callWithRetry<T>(action, params, method, opts.signal);
    if (cacheKey) this.cache.set(cacheKey, result as object);
    return result;
  }

  private async callWithRetry<T>(
    action: string,
    params: Record<string, unknown>,
    method: "GET" | "POST",
    signal?: AbortSignal,
  ): Promise<T> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.callOnce<T>(action, params, method, signal);
      } catch (err) {
        lastErr = err;
        const status = err instanceof CkanError ? err.httpStatus : 0;
        const retryable = err instanceof CkanServerError || RETRYABLE.has(status ?? 0);
        if (!retryable || attempt === maxAttempts) throw err;
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 5000);
        this.log.warn("ckan retry", { action, attempt, status, backoff });
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  private async callOnce<T>(
    action: string,
    params: Record<string, unknown>,
    method: "GET" | "POST",
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { "user-agent": this.config.userAgent };
    let url = `${this.config.baseUrl}/${action}`;
    let body: string | undefined;

    if (method === "GET") {
      const qs = toQueryString(params);
      if (qs) url += `?${qs}`;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(params);
    }

    this.log.debug("ckan call", { action, method });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.config.httpTimeoutMs);
    if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
    let status: number;
    let text: string;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: ac.signal });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    let env: CkanEnvelope<T>;
    try {
      env = JSON.parse(text) as CkanEnvelope<T>;
    } catch {
      if (status >= 500) throw new CkanServerError(`Non-JSON ${status} response`, status);
      const retryAfter = res.headers.get("retry-after");
      if (status === 429 && retryAfter) await sleep(parseRetryAfter(retryAfter));
      throw new CkanError(`Non-JSON response from ${action} (HTTP ${status})`, undefined, status);
    }

    if (env.success && env.result !== undefined) return env.result;

    const msg = normalizeMessage(env.error?.message) ?? `CKAN call ${action} failed`;
    throw toCkanError(env.error?.__type, msg, status);
  }
}

function toQueryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return sp.toString();
}

function normalizeMessage(message?: string | string[]): string | undefined {
  if (!message) return undefined;
  return Array.isArray(message) ? message.join("; ") : message;
}

function parseRetryAfter(value: string): number {
  const secs = Number(value);
  return Number.isFinite(secs) ? secs * 1000 : 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
