import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { CkanClient } from "../../src/ckan/client.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/util/logger.js";
import { findDatasets } from "../../src/tools/find-datasets.js";
import type { ToolContext } from "../../src/tools/types.js";

const BASE = "https://data.gov.ua/api/3/action";

const fixture = {
  success: true,
  result: {
    count: 42,
    results: [
      {
        id: "uuid-1",
        name: "uuid-1",
        title: "Дані про екологію",
        notes: "Опис ".repeat(80), // long → must be snippetted
        metadata_modified: "2026-06-01T00:00:00",
        num_resources: 2,
        organization: { id: "o", title: "Розпорядник X" },
        resources: [
          { id: "r1", format: "csv" },
          { id: "r2", format: "xlxs" }, // dirty → XLSX
        ],
      },
    ],
    search_facets: {
      organization: { items: [{ name: "o", display_name: "Розпорядник X", count: 10 }] },
      res_format: { items: [{ name: "CSV", count: 5 }] },
      groups: { items: [] },
    },
  },
};

const server = setupServer(
  http.get(`${BASE}/package_search`, () => HttpResponse.json(fixture)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctx(): ToolContext {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const log = createLogger({ logLevel: "error" });
  return { ckan: new CkanClient(config, log), config, log };
}

describe("find_datasets", () => {
  it("returns slim projected hits with normalized formats and refine hints", async () => {
    const tool = findDatasets(ctx());
    const out = JSON.parse(await tool.handler({ query: "екологія", limit: 5 }));

    expect(out.count).toBe(42);
    const hit = out.results[0];
    expect(hit.id).toBe("uuid-1");
    expect(hit.org_title).toBe("Розпорядник X");
    expect(hit.formats).toEqual(["CSV", "XLSX"]); // xlxs normalized
    expect(hit.machine_readable).toBe(true);
    expect(hit.why_relevant.length).toBeLessThanOrEqual(201); // snippet cap
    expect(hit.dataset_url).toContain("uuid-1");
    // No raw heavy fields leaked
    expect(hit.resources).toBeUndefined();
    expect(hit.notes).toBeUndefined();
    expect(out.refine_hints.organizations[0].value).toBe("o");
  });
});
