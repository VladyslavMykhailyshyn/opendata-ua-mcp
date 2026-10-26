import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp, drainHttpApp } from "../../src/http-app.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/util/logger.js";

const CKAN = "https://data.gov.ua/api/3/action";

// msw patches globalThis.fetch on listen(); its passthrough stalls on the MCP
// client's streamed responses, so test-side traffic uses the unpatched fetch.
const realFetch = globalThis.fetch;

const ckanMock = setupServer(
  http.get(`${CKAN}/package_search`, () =>
    HttpResponse.json({
      success: true,
      result: {
        count: 1,
        results: [
          {
            id: "uuid-1",
            name: "uuid-1",
            title: "Реєстр викрадених авто",
            notes: "Опис",
            metadata_modified: "2026-06-01T00:00:00",
            num_resources: 1,
            organization: { id: "o", title: "МВС" },
            resources: [{ id: "r1", format: "csv" }],
          },
        ],
        search_facets: {},
      },
    }),
  ),
);

const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let base: string;
const extraApps: Server[] = [];

async function startApp(env: Record<string, string> = {}): Promise<{ app: Server; base: string }> {
  const config = loadConfig(env as NodeJS.ProcessEnv);
  const server = createHttpApp({ config, log: createLogger({ logLevel: "error" }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  extraApps.push(server);
  return { app: server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return realFetch(url, { method: "POST", headers: { ...RPC_HEADERS, ...headers }, body });
}

beforeAll(async () => {
  ckanMock.listen({ onUnhandledRequest: "error" });
  ({ base } = await startApp());
});

afterAll(async () => {
  await Promise.all(extraApps.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  ckanMock.close();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: realFetch }),
  );
  return client;
}

describe("HTTP transport", () => {
  it("serves health check", async () => {
    const res = await realFetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("lists all read tools over MCP", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "explore_catalog",
      "filter_data",
      "find_datasets",
      "get_dataset_data",
      "inspect_dataset",
      "track_updates",
    ]);
    await client.close();
  });

  it("calls a tool end-to-end", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "find_datasets",
      arguments: { query: "викрадені" },
    });
    const [first] = result.content as Array<{ type: string; text: string }>;
    const out = JSON.parse(first.text);
    expect(out.count).toBe(1);
    expect(out.results[0].org_title).toBe("МВС");
    await client.close();
  });

  it("handles independent clients concurrently", async () => {
    const clients = await Promise.all([connect(), connect(), connect()]);
    const lists = await Promise.all(clients.map((c) => c.listTools()));
    expect(lists.every((l) => l.tools.length === 6)).toBe(true);
    await Promise.all(clients.map((c) => c.close()));
  });

  it("rejects GET on /mcp with 405", async () => {
    const res = await realFetch(`${base}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 404 for unknown paths", async () => {
    expect((await realFetch(`${base}/nope`)).status).toBe(404);
  });

  it("returns JSON-RPC parse error for invalid JSON", async () => {
    const res = await post(`${base}/mcp`, "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("rejects oversized bodies with 413 and closes the connection", async () => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("rejects JSON-RPC batches", async () => {
    const res = await post(`${base}/mcp`, `[${LIST_TOOLS},${LIST_TOOLS}]`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/batch/i);
  });

  it("is open without a token by default", async () => {
    const res = await post(`${base}/mcp`, LIST_TOOLS);
    expect(res.status).toBe(200);
  });
});

describe("HTTP transport hardening", () => {
  it("requires the bearer token when MCP_AUTH_TOKEN is set", async () => {
    const token = "0123456789abcdef";
    const { base: b } = await startApp({ MCP_AUTH_TOKEN: token });

    const anon = await post(`${b}/mcp`, LIST_TOOLS);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe("Bearer");
    expect((await anon.json()).error.code).toBe(-32000);

    const wrong = await post(`${b}/mcp`, LIST_TOOLS, { authorization: `Bearer ${token}x` });
    expect(wrong.status).toBe(401);

    const ok = await post(`${b}/mcp`, LIST_TOOLS, { authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.tools.length).toBe(6);

    // Health stays unauthenticated for probes.
    expect((await realFetch(`${b}/health`)).status).toBe(200);
  });

  it("answers 421 when the Host header is not allowed", async () => {
    const { base: b } = await startApp({ MCP_ALLOWED_HOSTS: "mcp.example.com, MCP.Internal:3000" });

    const bad = await post(`${b}/mcp`, LIST_TOOLS);
    expect(bad.status).toBe(421);

    // undici won't override Host; use node:http for the allowed value.
    const good = await rawPost(b, LIST_TOOLS, { host: "mcp.internal:3000" });
    expect(good.status).toBe(200);
  });

  it("rate-limits per client IP with retry-after", async () => {
    const { base: b } = await startApp({ MCP_RATE_LIMIT_PER_MINUTE: "2" });
    expect((await post(`${b}/mcp`, LIST_TOOLS)).status).toBe(200);
    expect((await post(`${b}/mcp`, LIST_TOOLS)).status).toBe(200);
    const limited = await post(`${b}/mcp`, LIST_TOOLS);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe(-32000);
    // Health is not metered.
    expect((await realFetch(`${b}/health`)).status).toBe(200);
  });

  it("answers 503 on every route while draining", async () => {
    const { app: a, base: b } = await startApp();
    expect((await realFetch(`${b}/health`)).status).toBe(200);
    drainHttpApp(a);

    const health = await realFetch(`${b}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "draining" });

    const mcp = await post(`${b}/mcp`, LIST_TOOLS);
    expect(mcp.status).toBe(503);
    expect((await mcp.json()).error.code).toBe(-32000);
  });
});

function rawPost(
  b: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  const url = new URL(`${b}/mcp`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { ...RPC_HEADERS, "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
