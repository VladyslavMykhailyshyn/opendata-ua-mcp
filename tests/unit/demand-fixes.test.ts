import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { officeContainerFormat } from "../../src/util/zip.js";
import { decodeText, trimToLastLine } from "../../src/util/download.js";
import { parseJsonTable, salvageJsonRecords } from "../../src/util/csv.js";
import { pickBestResource } from "../../src/util/resource-picker.js";
import { isMachineReadable, normalizeFormat } from "../../src/util/formats.js";
import type { CkanResource } from "../../src/ckan/types.js";

function spreadsheet(bookType: "xlsx" | "ods"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["назва"], ["Київ"]]), "s");
  return XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
}

describe("officeContainerFormat", () => {
  it("recognizes XLSX and ODS containers", () => {
    expect(officeContainerFormat(spreadsheet("xlsx"))).toBe("XLSX");
    expect(officeContainerFormat(spreadsheet("ods"))).toBe("ODS");
  });

  it("leaves data archives alone", () => {
    const zip = new AdmZip();
    zip.addFile("data.csv", Buffer.from("a\n1"));
    expect(officeContainerFormat(zip.toBuffer())).toBeUndefined();
  });

  it("works on a truncated prefix", () => {
    expect(officeContainerFormat(spreadsheet("xlsx").subarray(0, 64))).toBe("XLSX");
  });
});

describe("truncated UTF-8 text", () => {
  it("decodes as UTF-8 after trimming a split multi-byte character", () => {
    const full = Buffer.from("назва;рік\nКиїв;2024\nЛьвів;2023\n", "utf8");
    const cut = full.subarray(0, full.length - 3); // ends inside "2023"... and a row
    const midChar = Buffer.concat([cut, Buffer.from("Од", "utf8").subarray(0, 3)]);
    expect(decodeText(midChar)).not.toContain("Київ"); // the bug: cp1251 fallback
    const text = decodeText(trimToLastLine(midChar));
    expect(text).toBe("назва;рік\nКиїв;2024\n");
  });

  it("keeps a buffer without newlines as-is", () => {
    const b = Buffer.from("abc");
    expect(trimToLastLine(b)).toBe(b);
  });
});

describe("salvageJsonRecords", () => {
  it("recovers complete records from a truncated wrapped array", () => {
    const text = '{"meta":{"n":3},"items":[{"a":1,"s":"x}"},{"a":2,"s":"\\"q\\""},{"a":3,"s":"cu';
    expect(salvageJsonRecords(text)).toEqual([
      { a: 1, s: "x}" },
      { a: 2, s: '"q"' },
    ]);
  });

  it("is used by parseJsonTable when JSON is invalid", () => {
    const t = parseJsonTable('[{"a":1},{"a":2},{"a"', 10);
    expect(t.rowCount).toBe(2);
  });

  it("still throws when nothing is recoverable", () => {
    expect(() => parseJsonTable("{not json", 10)).toThrow();
  });
});

describe("pickBestResource on yearly registries", () => {
  const r = (p: Partial<CkanResource>): CkanResource => ({ id: "x", url: "http://f", ...p });

  it("picks the newest of equally good resources", () => {
    const best = pickBestResource([
      r({ id: "2023", format: "ZIP", last_modified: "2024-01-01T00:00:00" }),
      r({ id: "2026", format: ".zip", last_modified: "2026-09-01T00:00:00" }),
      r({ id: "2025", format: ".zip", last_modified: "2026-05-08T00:00:00" }),
    ]);
    expect(best?.id).toBe("2026");
  });

  it("still prefers a better format over a newer one", () => {
    const best = pickBestResource([
      r({ id: "csv", format: "CSV", last_modified: "2020-01-01T00:00:00" }),
      r({ id: "zip", format: "ZIP", last_modified: "2026-01-01T00:00:00" }),
    ]);
    expect(best?.id).toBe("csv");
  });
});

describe("formats", () => {
  it("normalizes zipped-CSV labels and treats ODS as machine-readable", () => {
    expect(normalizeFormat("csv, zip")).toBe("ZIP");
    expect(normalizeFormat("CSV ZIP")).toBe("ZIP");
    expect(isMachineReadable("ods")).toBe(true);
  });
});
