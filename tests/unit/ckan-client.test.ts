import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CkanClient } from "../../src/ckan/client.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/util/logger.js";

const OK = JSON.stringify({ success: true, result: { ok: true } });

function client(): CkanClient {
  const config = loadConfig({ HTTP_TIMEOUT_MS: "1000" } as unknown as NodeJS.ProcessEnv);
  return new CkanClient(config, createLogger({ logLevel: "error" }));
}

/** Queue of responses; a function may use the request signal to abort. */
function stubFetch(
  ...responses: Array<(() => Response | Promise<Response>) | Response>
): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error("no more stubbed responses");
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const html = (status: number, headers: Record<string, string> = {}) =>
  new Response("<html><body>nginx</body></html>", { status, headers });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CkanClient retries", () => {
  it("does not retry when the caller's signal is already aborted", async () => {
    const fetchMock = stubFetch(new Response(OK));
    const ac = new AbortController();
    ac.abort();
    await expect(client().call("status_show", {}, { signal: ac.signal })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a request aborted in flight", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ac = new AbortController();
    const p = client().call("status_show", {}, { signal: ac.signal });
    const outcome = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0); // let the request start
    expect(fetchMock).toHaveBeenCalledTimes(1);
    ac.abort();
    await outcome;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a request whose caller aborted while queued", async () => {
    const fetchMock = stubFetch(new Response(OK));
    const ac = new AbortController();
    const p = client().call("status_show", {}, { signal: ac.signal });
    const outcome = expect(p).rejects.toThrow();
    ac.abort(); // between semaphore acquire and fetch
    await outcome;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry an upstream timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = client().call("status_show");
    const outcome = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000); // HTTP_TIMEOUT_MS
    await outcome;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 once, waiting Retry-After capped at 5 s", async () => {
    const fetchMock = stubFetch(
      html(429, { "retry-after": "60" }),
      html(429, { "retry-after": "60" }),
      new Response(OK),
    );
    const p = client().call("package_search");
    const outcome = expect(p).rejects.toThrow("HTTP 429");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await outcome;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the single 429 retry succeeds", async () => {
    const fetchMock = stubFetch(html(429, { "retry-after": "1" }), new Response(OK));
    const p = client().call("package_search");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off 5xx with jitter inside ±25% of the base delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let fetchMock = stubFetch(html(503), new Response(OK));
    let p = client().call("package_search");
    await vi.advanceTimersByTimeAsync(749);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual({ ok: true });

    vi.spyOn(Math, "random").mockReturnValue(0.999);
    fetchMock = stubFetch(html(503), new Response(OK));
    p = client().call("package_search");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("gives up after three attempts on 5xx", async () => {
    const fetchMock = stubFetch(html(502), html(502), html(502), new Response(OK));
    const p = client().call("package_search");
    const outcome = expect(p).rejects.toThrow("Non-JSON 502");
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops a backoff sleep when the signal aborts", async () => {
    const fetchMock = stubFetch(html(503), new Response(OK));
    const ac = new AbortController();
    const p = client().call("package_search", {}, { signal: ac.signal });
    const outcome = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await outcome;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never forwards the upstream HTML body in error messages", async () => {
    stubFetch(html(404));
    const err = await client()
      .call("package_show", { id: "x" })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("Non-JSON response from package_show (HTTP 404)");
    expect((err as Error).message).not.toContain("nginx");
  });
});
