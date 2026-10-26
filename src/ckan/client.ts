import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import { createCache } from "../util/cache.js";
import { isAbortError } from "../util/errors.js";
import { Semaphore } from "../util/semaphore.js";
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

const RETRYABLE = new Set([0, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5_000;

// Retry-After of a 429, keyed by the error it came with; keeps CkanError's
// public shape unchanged.
const retryAfterOf = new WeakMap<CkanError, number>();

/**
 * Thin CKAN Action API client. One public method `call`. Handles GET/POST,
 * the {success,result,error} envelope, typed errors, retry-with-backoff on
 * 5xx/network, Retry-After, and an LRU cache for idempotent calls.
 */
export class CkanClient {
  private readonly cache: ReturnType<typeof createCache<object>>;
  private readonly defaultSignal?: AbortSignal;
  /** Process-wide cap on simultaneous requests to the portal (API + downloads). */
  readonly upstream: Semaphore;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    shared?: {
      cache: ReturnType<typeof createCache<object>>;
      upstream: Semaphore;
      signal?: AbortSignal;
    },
  ) {
    this.cache = shared?.cache ?? createCache<object>(config.cacheTtlSeconds);
    this.upstream = shared?.upstream ?? new Semaphore(config.maxConcurrentUpstream, 1000);
    this.defaultSignal = shared?.signal;
  }

  /**
   * A view of this client bound to a tool call's signal: same cache and
   * upstream limiter, every call aborts when the client disconnects or the
   * tool deadline passes.
   */
  withSignal(signal: AbortSignal): CkanClient {
    return new CkanClient(this.config, this.log, {
      cache: this.cache,
      upstream: this.upstream,
      signal,
    });
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

    const signal = combineSignals(opts.signal, this.defaultSignal);
    const result = await this.callWithRetry<T>(action, params, method, signal);
    if (cacheKey) this.cache.set(cacheKey, result as object);
    return result;
  }

  private async callWithRetry<T>(
    action: string,
    params: Record<string, unknown>,
    method: "GET" | "POST",
    signal?: AbortSignal,
  ): Promise<T> {
    let rateLimitRetried = false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce<T>(action, params, method, signal);
      } catch (err) {
        // A timed-out or disconnected caller is gone: never retry on its behalf.
        if (signal?.aborted || isAbortError(err)) throw err;
        const status = err instanceof CkanError ? err.httpStatus : 0;
        let backoff: number;
        if (status === 429) {
          // The portal shares one rate limit across all our callers: one
          // polite retry, then give up so queued calls don't pile on.
          if (rateLimitRetried || attempt >= MAX_ATTEMPTS) throw err;
          rateLimitRetried = true;
          backoff = retryAfterOf.get(err as CkanError) ?? jittered(attempt);
        } else {
          const retryable = err instanceof CkanServerError || RETRYABLE.has(status ?? 0);
          if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
          backoff = jittered(attempt);
        }
        this.log.warn("ckan retry", { action, attempt, status, backoff });
        await sleep(backoff, signal);
      }
    }
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

    // The upstream slot is held for the whole exchange, body included, so the
    // portal never sees more than maxConcurrentUpstream open connections.
    const { status, text, retryAfter } = await this.upstream.run(async () => {
      // The caller may have gone away while this call waited for a slot.
      if (signal?.aborted) throw signal.reason;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.config.httpTimeoutMs);
      const onAbort = () => ac.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, { method, headers, body, signal: ac.signal });
        return {
          status: res.status,
          text: await res.text(),
          retryAfter: res.headers.get("retry-after"),
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }, signal);

    let env: CkanEnvelope<T>;
    try {
      env = JSON.parse(text) as CkanEnvelope<T>;
    } catch {
      // Never forward the upstream body: it is nginx/HTML, not for clients.
      if (status >= 500) throw new CkanServerError(`Non-JSON ${status} response`, status);
      throw rateLimited(
        new CkanError(`Non-JSON response from ${action} (HTTP ${status})`, undefined, status),
        status,
        retryAfter,
      );
    }

    if (env.success && env.result !== undefined) return env.result;

    const msg = normalizeMessage(env.error?.message) ?? `CKAN call ${action} failed`;
    throw rateLimited(toCkanError(env.error?.__type, msg, status), status, retryAfter);
  }
}

function rateLimited(err: CkanError, status: number, retryAfter: string | null): CkanError {
  if (status === 429 && retryAfter) retryAfterOf.set(err, parseRetryAfter(retryAfter));
  return err;
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

/** Seconds or an HTTP date; capped so one upstream header can't stall a call. */
function parseRetryAfter(value: string): number {
  const secs = Number(value);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const at = Date.parse(value);
    ms = Number.isFinite(at) ? at - Date.now() : 1000;
  }
  return Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS));
}

/** Exponential backoff with ±25% jitter so retries from parallel calls spread out. */
function jittered(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 5000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}
