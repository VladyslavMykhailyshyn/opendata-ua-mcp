import { describe, it, expect } from "vitest";
import { humanSize, relativeAge, licenseUrl } from "../../src/util/humanize.js";

describe("humanSize", () => {
  it("formats bytes", () => {
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(2048)).toBe("2.0 KB");
    expect(humanSize(5_242_880)).toBe("5.0 MB");
  });
  it("accepts numeric strings and rejects junk", () => {
    expect(humanSize("1024")).toBe("1.0 KB");
    expect(humanSize(null)).toBeUndefined();
    expect(humanSize("abc")).toBeUndefined();
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-06-21T12:00:00Z");
  it("computes relative ages deterministically", () => {
    expect(relativeAge("2026-06-19T12:00:00Z", now)).toBe("2 days ago");
    expect(relativeAge("2026-06-21T11:00:00Z", now)).toBe("1 hour ago");
  });
  it("handles bad input", () => {
    expect(relativeAge(undefined, now)).toBeUndefined();
  });
});

describe("licenseUrl", () => {
  it("prefers existing url, else maps id", () => {
    expect(licenseUrl("cc-by", "https://x")).toBe("https://x");
    expect(licenseUrl("cc-by")).toContain("creativecommons.org");
    expect(licenseUrl("unknown-xyz")).toBeUndefined();
  });
});
