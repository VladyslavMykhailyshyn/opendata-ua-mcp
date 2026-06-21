import { describe, it, expect } from "vitest";
import { normalizeFormat, isMachineReadable } from "../../src/util/formats.js";

describe("normalizeFormat", () => {
  it("uppercases and strips leading dots", () => {
    expect(normalizeFormat("csv")).toBe("CSV");
    expect(normalizeFormat(".csv")).toBe("CSV");
  });

  it("normalizes the dirty data.gov.ua variants", () => {
    expect(normalizeFormat("xlxs")).toBe("XLSX");
    expect(normalizeFormat("xls xlsx")).toBe("XLSX");
    expect(normalizeFormat("EXCEL (.XLSX)")).toBe("XLSX");
    expect(normalizeFormat("excel")).toBe("XLSX");
    expect(normalizeFormat("application/x-7z-compressed")).toBe("7Z");
  });

  it("folds Cyrillic homoglyph in '.сsv' (Cyrillic с U+0441)", () => {
    expect(normalizeFormat(".сsv")).toBe("CSV");
  });

  it("returns empty string for blank", () => {
    expect(normalizeFormat("")).toBe("");
    expect(normalizeFormat(undefined)).toBe("");
  });
});

describe("isMachineReadable", () => {
  it("flags structured formats", () => {
    expect(isMachineReadable("CSV")).toBe(true);
    expect(isMachineReadable("xlxs")).toBe(true);
    expect(isMachineReadable("json")).toBe(true);
  });
  it("rejects documents", () => {
    expect(isMachineReadable("DOC")).toBe(false);
    expect(isMachineReadable("PDF")).toBe(false);
  });
});
