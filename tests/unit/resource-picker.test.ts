import { describe, it, expect } from "vitest";
import { pickBestResource } from "../../src/util/resource-picker.js";
import type { CkanResource } from "../../src/ckan/types.js";

const r = (p: Partial<CkanResource>): CkanResource => ({ id: p.id ?? "x", url: "http://f", ...p });

describe("pickBestResource", () => {
  it("prefers CSV over PDF", () => {
    const best = pickBestResource([r({ id: "a", format: "PDF" }), r({ id: "b", format: "CSV" })]);
    expect(best?.id).toBe("b");
  });
  it("prefers datastore-active resource", () => {
    const best = pickBestResource([
      r({ id: "a", format: "CSV" }),
      r({ id: "b", format: "JSON", datastore_active: true }),
    ]);
    expect(best?.id).toBe("b");
  });
  it("returns undefined when nothing parseable", () => {
    expect(pickBestResource([r({ format: "DOC" }), r({ format: "PDF" })])).toBeUndefined();
  });
  it("skips deleted and url-less resources", () => {
    const best = pickBestResource([
      r({ id: "a", format: "CSV", state: "deleted" }),
      r({ id: "b", format: "CSV", url: undefined }),
    ]);
    expect(best).toBeUndefined();
  });
});
