import { describe, it, expect } from "vitest";
import { filterData } from "../../src/tools/filter-data.js";
import type { ToolContext } from "../../src/tools/types.js";

// SQL guard runs before any network call, so a stub ckan never gets hit.
const ctx = { ckan: {} as never, config: {} as never, log: {} as never } as ToolContext;
const tool = filterData(ctx);

describe("filter_data SQL guard", () => {
  for (const bad of [
    'DELETE FROM "r"',
    'SELECT 1; DROP TABLE x',
    'UPDATE "r" SET a=1',
    "INSERT INTO r VALUES (1)",
    "TRUNCATE r",
  ]) {
    it(`rejects: ${bad}`, async () => {
      await expect(tool.handler({ resource_id: "r", sql: bad })).rejects.toThrow();
    });
  }
});
