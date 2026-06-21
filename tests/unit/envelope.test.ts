import { describe, it, expect } from "vitest";
import { makeEnvelope, capPayload } from "../../src/util/envelope.js";

describe("makeEnvelope", () => {
  it("sets more/next_offset when results remain", () => {
    const env = makeEnvelope({ count: 100, results: [1, 2, 3], offset: 0, sourceUrl: "u" });
    expect(env.more).toBe(true);
    expect(env.next_offset).toBe(3);
    expect(env.returned).toBe(3);
  });
  it("no continuation when exhausted", () => {
    const env = makeEnvelope({ count: 2, results: [1, 2], offset: 0, sourceUrl: "u" });
    expect(env.more).toBe(false);
    expect(env.next_offset).toBeUndefined();
  });
});

describe("capPayload", () => {
  it("truncates results to fit the char ceiling", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ i, blob: "x".repeat(200) }));
    const env = makeEnvelope({ count: 50, results: big, offset: 0, sourceUrl: "u" });
    const json = capPayload(env, { maxResponseChars: 2000 });
    expect(json.length).toBeLessThanOrEqual(2000 + 500);
    const parsed = JSON.parse(json);
    expect(parsed.returned).toBeLessThan(50);
    expect(parsed.more).toBe(true);
    expect(parsed.note).toContain("truncated");
  });
});
