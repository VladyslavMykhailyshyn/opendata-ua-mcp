import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../../src/http-app.js";
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

let app: Server;
let base: string;

beforeAll(async () => {
  ckanMock.listen({ onUnhandledRequest: "error" });
  const config = loadConfig({} as NodeJS.ProcessEnv);
  app = createHttpApp({ config, log: createLogger({ logLevel: "error" }) });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
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
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("rejects oversized bodies with 413", async () => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
  });
});
