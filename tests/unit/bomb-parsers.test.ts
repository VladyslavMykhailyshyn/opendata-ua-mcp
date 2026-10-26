import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { pickBestZipEntry } from "../../src/util/zip.js";
import { MAX_COLUMNS, parseCsv, parseJsonTable, parseXlsx } from "../../src/util/csv.js";

function timed<T>(fn: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
}

describe("ZIP entries", () => {
  it("skips an entry whose header declares more than maxBytes without inflating it", () => {
    const zip = new AdmZip();
    zip.addFile("huge.csv", Buffer.alloc(4_000_000, 0)); // compresses to a few KB
    zip.addFile("small.xml", Buffer.from("<r><x>1</x></r>"));
    const buf = zip.toBuffer();
    expect(buf.length).toBeLessThan(50_000);

    const { result, ms } = timed(() => pickBestZipEntry(buf, 1_000_000));
    // CSV ranks above XML; it was passed over on size, not inflated and then rejected.
    expect(result.best?.name).toBe("small.xml");
    expect(result.skipped).toBe(1);
    expect(result.names).toEqual(["huge.csv", "small.xml"]);
    expect(ms).toBeLessThan(500);
  });

  it("reports no best entry when every candidate is too big", () => {
    const zip = new AdmZip();
    zip.addFile("huge.csv", Buffer.alloc(2_000_000, 0));
    const r = pickBestZipEntry(zip.toBuffer(), 1_000_000);
    expect(r.best).toBeUndefined();
    expect(r.skipped).toBe(1);
  });

  it("treats an encrypted entry as unusable without throwing", () => {
    const zip = new AdmZip();
    zip.addFile("data.csv", Buffer.from("a\n1"));
    zip.addFile("other.xml", Buffer.from("<r/>"));
    zip.getEntry("data.csv")!.header.flags = 1;
    const r = pickBestZipEntry(zip.toBuffer(), 1_000_000);
    expect(r.best?.name).toBe("other.xml");
    expect(r.skipped).toBe(1);
  });

  it("never returns an entry that inflates past maxBytes despite a small header", () => {
    const zip = new AdmZip();
    zip.addFile("data.csv", Buffer.alloc(200_000, 0x31));
    const buf = zip.toBuffer();
    // Lie in the central directory: declare 10 bytes for a 200 KB entry
    // (uncompressed size sits 24 bytes into the central file header).
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cd).toBeGreaterThan(0);
    buf.writeUInt32LE(10, cd + 24);
    expect(new AdmZip(buf).getEntry("data.csv")!.header.size).toBe(10);
    // adm-zip 0.6 itself refuses to inflate past the declared size; whichever
    // layer catches it, the picker must throw rather than hand back 200 KB.
    expect(() => pickBestZipEntry(buf, 100_000)).toThrow();
  });

  it("caps the reported entry list", () => {
    const zip = new AdmZip();
    for (let i = 0; i < 40; i++) zip.addFile(`f${i}.pdf`, Buffer.from("x"));
    expect(pickBestZipEntry(zip.toBuffer()).names).toHaveLength(20);
  });
});

describe("spreadsheet bombs", () => {
  it("ignores a <dimension> claiming the whole grid", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["назва"], ["Київ"]]), "s");
    const xlsx = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const zip = new AdmZip(xlsx);
    const sheetEntry = zip.getEntry("xl/worksheets/sheet1.xml")!;
    const xml = sheetEntry.getData().toString("utf8");
    expect(xml).toMatch(/<dimension ref="A1:A2"\/>/);
    zip.updateFile(
      sheetEntry,
      Buffer.from(xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:XFD1048576"/>')),
    );
    const bomb = zip.toBuffer();

    const { result, ms } = timed(() => parseXlsx(bomb, 10));
    expect(ms).toBeLessThan(2000);
    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ назва: "Київ" }]);
    expect(result.rowCountIsLowerBound).toBeUndefined();
  });

  it("clamps a wide sheet to MAX_COLUMNS and reports a lower-bound row count past the sample", () => {
    const wide = [
      Array.from({ length: 700 }, (_, i) => `c${i}`),
      Array.from({ length: 700 }, (_, i) => i),
    ];
    const tall = [["v"], ...Array.from({ length: 1500 }, (_, i) => [i])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wide), "wide");
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(tall), "tall");

    const w = parseXlsx(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, 10);
    expect(w.columns).toHaveLength(MAX_COLUMNS);
    expect(w.droppedColumns).toBe(200);

    const t = parseXlsx(XLSX.write(wb2, { type: "buffer", bookType: "xlsx" }) as Buffer, 10);
    expect(t.rowCount).toBe(1010);
    expect(t.rowCountIsLowerBound).toBe(true);
    expect(t.rows).toHaveLength(10);
  });
});

describe("CSV bombs", () => {
  it("caps a 100k-column header at MAX_COLUMNS and still counts every row", () => {
    const header = Array.from({ length: 100_000 }, (_, i) => `c${i}`).join(",");
    const row = Array.from({ length: 50 }, (_, i) => String(i)).join(",");
    const text = `${header}\n${`${row}\n`.repeat(10_000)}`;

    const { result, ms } = timed(() => parseCsv(text, 10));
    expect(ms).toBeLessThan(2000);
    expect(result.columns).toHaveLength(MAX_COLUMNS);
    expect(result.droppedColumns).toBe(100_000 - MAX_COLUMNS);
    expect(result.rowCount).toBe(10_000);
    expect(result.rows).toHaveLength(10);
    expect(Object.keys(result.rows[0]!)).toHaveLength(MAX_COLUMNS);
  });

  it("drops a single 10 MB line with an unclosed quote quickly", () => {
    const text = `a,b\n"${"x".repeat(10_000_000)}\n1,2\n`;
    const { result, ms } = timed(() => parseCsv(text, 10));
    expect(ms).toBeLessThan(2000);
    expect(result.droppedRows).toBe(1);
    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("does not re-parse the whole file when an unclosed quote spans many lines", () => {
    const text = `a,b\n"open,1\n${"x,y\n".repeat(2_500_000)}`; // ~10 MB
    const { result, ms } = timed(() => parseCsv(text, 10));
    expect(ms).toBeLessThan(2000);
    expect(result.droppedRows).toBeGreaterThan(0);
    expect(result.rowCount).toBeGreaterThan(2_000_000);
  });

  it("re-parses only bounded pending text when every line has a quote", () => {
    const text = `a,b\n${'"q,1\n'.repeat(1_000_000)}`;
    const { result, ms } = timed(() => parseCsv(text, 10));
    expect(ms).toBeLessThan(2000);
    expect(result.rowCount).toBe(0);
    expect(result.droppedRows).toBe(1_000_000);
  });
});

describe("JSON bombs", () => {
  it("caps a 500k-key object at MAX_COLUMNS", () => {
    const keys: string[] = [];
    for (let i = 0; i < 500_000; i++) keys.push(`"k${i}":${i}`);
    const text = `[{${keys.join(",")}},{"k0":1}]`;

    const { result, ms } = timed(() => parseJsonTable(text, 10));
    expect(ms).toBeLessThan(2000);
    expect(result.columns).toHaveLength(MAX_COLUMNS);
    expect(result.droppedColumns).toBe(500_000 - MAX_COLUMNS);
    expect(Object.keys(result.rows[0]!)).toHaveLength(MAX_COLUMNS);
    expect(result.rowCount).toBe(2);
  });

  it("builds objects only for the sample and counts the rest", () => {
    const text = `[${Array.from({ length: 5000 }, (_, i) => `{"a":${i}}`).join(",")}]`;
    const r = parseJsonTable(text, 10);
    expect(r.rowCount).toBe(5000);
    expect(r.rows).toHaveLength(10);
    // Truncated variant goes through the salvage scanner with the same caps.
    const cut = parseJsonTable(text.slice(0, -5), 10);
    expect(cut.rowCount).toBe(4999);
    expect(cut.rows).toHaveLength(10);
  });
});
