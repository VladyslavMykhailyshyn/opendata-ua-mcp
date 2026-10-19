import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import { csvRows, decodeStream, flatRecord, xmlRows, type Row } from "../../src/mirror/records.js";
import { parseCsvRecord, sniffDelimiter } from "../../src/util/delimited.js";
import { listZipEntries, openZipEntry } from "../../src/mirror/zip-stream.js";
import { MirrorReader, MirrorWriter, ftsQuery } from "../../src/mirror/store.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// Feed text in small chunks so records and tags straddle chunk boundaries.
async function* chunks(text: string, size = 7): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

describe("parseCsvRecord", () => {
  it("handles the unescaped inner quotes of the VAT payers export", () => {
    expect(parseCsvRecord('"ТОВ "ЗОНТА-ТРАНС"";"356383613199";"01.06.2011"', ";")).toEqual([
      'ТОВ "ЗОНТА-ТРАНС"',
      "356383613199",
      "01.06.2011",
    ]);
  });

  it("handles standard escaping, unquoted fields and empty trailing fields", () => {
    expect(parseCsvRecord('"P";"50 - ""X""";01.01.26;;', ";")).toEqual([
      "P",
      '50 - "X"',
      "01.01.26",
      "",
      "",
    ]);
  });

  it("reports an open quoted field", () => {
    expect(parseCsvRecord('"a";"multi', ";")).toBeUndefined();
  });
});

describe("csvRows", () => {
  it("sniffs the delimiter, joins multi-line records and drops null/empty", async () => {
    const tsv =
      '﻿"case"\t"court_name"\t"note"\r\n"1/2/24"\t"Суд"\t"рядок1\nрядок2"\r\n"3/4/24"\t"Суд 2"\tnull\r\n';
    const rows = await collect(csvRows(chunks(tsv)));
    expect(rows).toEqual([
      { case: "1/2/24", court_name: "Суд", note: "рядок1\nрядок2" },
      { case: "3/4/24", court_name: "Суд 2" },
    ]);
  });
});

describe("xmlRows", () => {
  it("flattens ЄДР SUBJECT blocks split across chunks", async () => {
    const xml =
      '<?xml version="1.0" encoding="windows-1251"?>\n<DATA>' +
      "<SUBJECT><NAME>&quot;ФЕРДАУС&quot;</NAME><EDRPOU>14359609</EDRPOU><FOUNDERS><FOUNDER>НУР</FOUNDER><FOUNDER>АХМАД</FOUNDER></FOUNDERS><PURPOSE/></SUBJECT>\n" +
      "<SUBJECT><NAME>ТОВ Б</NAME><EDRPOU>01234567</EDRPOU></SUBJECT></DATA>";
    const rows = await collect(xmlRows(chunks(xml, 13), "SUBJECT"));
    expect(rows).toEqual([
      { NAME: '"ФЕРДАУС"', EDRPOU: "14359609", FOUNDERS: "НУР; АХМАД" },
      { NAME: "ТОВ Б", EDRPOU: "01234567" },
    ]);
  });
});

describe("decodeStream", () => {
  it("honors the XML-declared windows-1251 encoding", async () => {
    const text = '<?xml version="1.0" encoding="windows-1251"?><S>Київ</S>';
    const cp1251 = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="windows-1251"?><S>', "latin1"),
      Buffer.from([0xca, 0xe8, 0xbf, 0xe2]), // "Київ" in Windows-1251
      Buffer.from("</S>", "latin1"),
    ]);
    const out = (await collect(decodeStream(Readable.from([cp1251])))).join("");
    expect(out).toBe(text);
  });

  it("detects UTF-8 CSV", async () => {
    const out = (await collect(decodeStream(Readable.from([Buffer.from("а;б\nв;г\n")])))).join("");
    expect(out).toBe("а;б\nв;г\n");
  });
});

describe("streaming ZIP reader", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mirror-zip-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists entries and streams a deflated entry", async () => {
    const big = "VIN;BRAND\n" + Array.from({ length: 5000 }, (_, i) => `VIN${i};BMW`).join("\n");
    const zip = new AdmZip();
    zip.addFile("schema.xsd", Buffer.from("<x/>"));
    zip.addFile("reestr.csv", Buffer.from(big));
    const path = join(dir, "a.zip");
    const buf = zip.toBuffer();
    await writeFile(path, buf);

    const entries = await listZipEntries(path, buf.length);
    expect(entries.map((e) => e.name).sort()).toEqual(["reestr.csv", "schema.xsd"]);
    const csv = entries.find((e) => e.name === "reestr.csv")!;
    expect(csv.method).toBe(8);
    const out = Buffer.concat(await collect(await openZipEntry(path, csv))).toString();
    expect(out).toBe(big);
  });
});

describe("MirrorWriter / MirrorReader", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mirror-db-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function build(rows: Row[]) {
    const w = await MirrorWriter.create(dir, "t", {
      format: "csv",
      exact: ["EDRPOU"],
      text: ["NAME"],
    });
    for (const r of rows) w.add(r);
    await w.commit({
      registry: "t",
      dataset: "d",
      resources: [],
      row_count: w.count,
      synced_at: "now",
    });
  }

  it("finds by exact code and by name prefix", async () => {
    await build([
      { NAME: "ТОВ «Ромашка-Плюс»", EDRPOU: "01234567" },
      { NAME: "ПП Волошка", EDRPOU: "76543210" },
    ]);
    const reader = new MirrorReader(dir);
    const exact = await reader.lookup("t", "0123 4567", 10);
    expect(exact).toMatchObject({ match: "exact", rows: [{ EDRPOU: "01234567" }] });
    const text = await reader.lookup("t", "ромаш плюс", 10);
    expect(text).toMatchObject({ match: "text", rows: [{ EDRPOU: "01234567" }] });
    expect((await reader.lookup("t", "неіснуюча", 10))?.rows).toEqual([]);
    expect((await reader.meta("t"))?.row_count).toBe(2);
    reader.close();
  });

  it("returns undefined for a registry not synced yet", async () => {
    expect(await new MirrorReader(dir).lookup("missing", "x", 1)).toBeUndefined();
  });

  it("builds FTS queries from words only", () => {
    expect(ftsQuery('ТОВ "Ромашка" OR x*')).toBe('"ТОВ"* "Ромашка"* "OR"* "x"*');
    expect(ftsQuery("«»")).toBeUndefined();
  });
});

describe("sniffDelimiter", () => {
  it("ignores delimiters inside quoted values", () => {
    expect(sniffDelimiter('"Суддя: А, Б, В"\t"1/2"\t"x, y"')).toBe("\t");
  });
});

describe("csvRows delimiter quirks", () => {
  it("reads rows whose delimiter differs from the header's (debtors register)", async () => {
    const csv =
      'DEBTOR_NAME;DEBTOR_BIRTHDATE;DEBTOR_CODE\r\n"КП ""ОПТИКА №9""","","20793942"\r\n"ПП ""Б""","","32751635"\r\n';
    expect(await collect(csvRows(chunks(csv)))).toEqual([
      { DEBTOR_NAME: 'КП "ОПТИКА №9"', DEBTOR_CODE: "20793942" },
      { DEBTOR_NAME: 'ПП "Б"', DEBTOR_CODE: "32751635" },
    ]);
  });
});

describe("flatRecord", () => {
  it("decodes entities, joins nested values, skips empty and self-closing", () => {
    expect(
      flatRecord(
        "<NAME>&quot;А&amp;Б&quot; &#1031;</NAME><EMPTY/><BLANK></BLANK>" +
          '<BRANCHES><BRANCH><NAME>Філія 1</NAME></BRANCH><BRANCH code="2"><NAME>Філія 2</NAME></BRANCH></BRANCHES>',
      ),
    ).toEqual({ NAME: '"А&Б" Ї', BRANCHES: "Філія 1; Філія 2" });
  });
});
