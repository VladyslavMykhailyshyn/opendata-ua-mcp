import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import AdmZip from "adm-zip";
import { csvRows, decodeStream, flatRecord, xmlRows, type Row } from "../../src/mirror/records.js";
import { parseCsvRecord, sniffDelimiter } from "../../src/util/delimited.js";
import { listZipEntries, openZipEntry } from "../../src/mirror/zip-stream.js";
import {
  MirrorReader,
  MirrorWriter,
  SENTINEL,
  assertSqliteNode,
  ftsQuery,
  type MirrorMeta,
} from "../../src/mirror/store.js";
import {
  MirrorLockedError,
  assertAllowedDownloadUrl,
  isUnchanged,
  lockMirror,
  pruneMirror,
} from "../../src/mirror/sync.js";
import { MIRRORED, settlementOnly } from "../../src/registries.js";
import { createLogger } from "../../src/util/logger.js";

const MB = 1024 * 1024;

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

  it("finds closing tags that straddle big chunks and records in long chunks", async () => {
    const rec = (i: number) => `<R><N>${"x".repeat(1000)}${i}</N></R>`;
    const xml = "<D>" + Array.from({ length: 300 }, (_, i) => rec(i)).join("\n") + "</D>";
    for (const size of [1, 4, 1001, 50_000, xml.length]) {
      const rows = await collect(xmlRows(chunks(xml, size), "R"));
      expect(rows.length).toBe(300);
      expect(rows[299]!.N!.endsWith("299")).toBe(true);
    }
  });

  it("refuses a record that never closes instead of buffering the whole file", async () => {
    async function* endless(): AsyncGenerator<string> {
      yield "<DATA><SUBJECT><NAME>";
      for (let i = 0; i < 20; i++) yield "а".repeat(MB);
    }
    await expect(collect(xmlRows(endless(), "SUBJECT"))).rejects.toThrow(/16 MB/);
  });
});

describe("csvRows buffer cap", () => {
  it("refuses a line longer than 16 MB", async () => {
    async function* noNewline(): AsyncGenerator<string> {
      yield "a;b\n";
      for (let i = 0; i < 20; i++) yield "x".repeat(MB);
    }
    await expect(collect(csvRows(noNewline()))).rejects.toThrow(/16 MB/);
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
    expect(exact!.ms).toBeGreaterThanOrEqual(0);
    const text = await reader.lookup("t", "ромаш плюс", 10);
    expect(text).toMatchObject({ match: "text", rows: [{ EDRPOU: "01234567" }] });
    expect((await reader.lookup("t", "неіснуюча", 10))?.rows).toEqual([]);
    expect((await reader.meta("t"))?.row_count).toBe(2);
    reader.close();
  });

  it("returns undefined for a registry not synced yet", async () => {
    expect(await new MirrorReader(dir).lookup("missing", "x", 1)).toBeUndefined();
  });

  it("ranks within a bounded candidate set and still puts the best match first", async () => {
    // The weak match is inserted first so rowid order alone would return it.
    const padded = Array.from({ length: 40 }, (_, i) => `слово${i}`).join(" ");
    await build([
      { NAME: `Ромашка ${padded}`, EDRPOU: "1" },
      { NAME: "Ромашка", EDRPOU: "2" },
      { NAME: "Ромашка Плюс", EDRPOU: "3" },
    ]);
    const reader = new MirrorReader(dir);
    const r = await reader.lookup("t", "ромаш", 2);
    expect(r!.rows.map((x) => x.EDRPOU)).toEqual(["2", "3"]);
    expect(r!.more).toBe(true);
    const all = await reader.lookup("t", "ромаш", 3);
    expect(all!.more).toBe(false);
    reader.close();
  });

  it("builds FTS queries: ≤6 terms, prefixes from 3 characters, short ones exact", () => {
    expect(ftsQuery('ТОВ "Ромашка" OR x*')).toBe('"ТОВ"* "Ромашка"* "OR" "x"');
    expect(ftsQuery("«»")).toBeUndefined();
    expect(ftsQuery("пп ів")).toBeUndefined();
    expect(ftsQuery("ПП")).toBeUndefined();
    expect(ftsQuery("Іва")).toBe('"Іва"*'); // 3 code points, not UTF-16 units
    expect(ftsQuery("a b c d e f g h")).toBeUndefined();
    expect(ftsQuery("aaa b c d e f ggg")).toBe('"aaa"* "b" "c" "d" "e" "f"');
  });

  it("insists on a Node with read-only node:sqlite", () => {
    expect(() => assertSqliteNode("22.11.0")).toThrow(/22\.12/);
    expect(() => assertSqliteNode("20.19.0")).toThrow(/22\.12/);
    assertSqliteNode("22.12.0");
    assertSqliteNode("24.1.0");
  });

  it("reports configured columns missing from the first 1000 rows, not the first row", async () => {
    const w = await MirrorWriter.create(dir, "t", {
      format: "csv",
      exact: ["A"],
      text: ["B", "Z"],
      keep: ["C", "K"],
    });
    for (let i = 1; i <= 1200; i++) {
      const row: Row = { A: String(i), B: "b" };
      if (i === 500) row.C = "c"; // sparse column, first seen late
      if (i === 1100) row.Z = "z"; // too late to count
      w.add(row);
    }
    expect(w.missingColumns()).toEqual({ required: ["Z"], kept: ["K"] });
    await w.abort();
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

  it("leaves numeric entities outside Unicode or in the surrogate range as written", () => {
    expect(
      flatRecord("<N>&#xD800; &#55296; &#x110000; &#1114112; &#x1F600; &#x10FFFF; &#0;</N>").N,
    ).toBe("&#xD800; &#55296; &#x110000; &#1114112; 😀 \u{10FFFF} \u0000");
  });
});

describe("settlementOnly (ЄДР ФОП address)", () => {
  it("keeps the address up to the settlement and drops street, house and flat", () => {
    expect(
      settlementOnly("Україна, 79000, Львівська обл., місто Львів, вул. Шевченка, буд. 1, кв. 2"),
    ).toBe("Україна, 79000, Львівська обл., місто Львів");
    expect(settlementOnly("Україна, 01001, м.Київ, вул. Хрещатик, буд. 5, кв. 12")).toBe(
      "Україна, 01001, м.Київ",
    );
    expect(
      settlementOnly(
        "Україна, 42343, Сумська обл., Сумський р-н, село Косівщина, вул. Миру, буд. 3",
      ),
    ).toBe("Україна, 42343, Сумська обл., Сумський р-н, село Косівщина");
    expect(settlementOnly("Україна, 61000, Харківська обл., смт Пісочин, просп. Гагаріна 7")).toBe(
      "Україна, 61000, Харківська обл., смт Пісочин",
    );
  });

  it("falls back to country, postcode and region, cut at a street marker", () => {
    expect(settlementOnly("Україна, 65000, Одеська обл., Одеса, Дерибасівська, 1")).toBe(
      "Україна, 65000, Одеська обл.",
    );
    expect(settlementOnly("Україна, вул. Садова, 3")).toBe("Україна");
    expect(settlementOnly("")).toBe("");
  });

  it("is wired into the ФОП mirror spec", () => {
    expect(MIRRORED.find((r) => r.key === "edr-fop")!.mirror.transform?.ADDRESS).toBe(
      settlementOnly,
    );
  });
});

describe("isUnchanged", () => {
  const fp = { id: "uo", url: "https://data.gov.ua/x/uo.zip", last_modified: "2026-10-01" };
  const meta = (over: Partial<MirrorMeta>, res: Partial<MirrorMeta["resources"][0]> = {}) => ({
    registry: "edr-uo",
    dataset: "d",
    resources: [{ ...fp, ...res }],
    row_count: 1,
    synced_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  });
  const WEEK = 7 * 24 * 3600 * 1000;

  it("needs the same id, url and last_modified", () => {
    expect(isUnchanged(meta({}), fp)).toBe(true);
    expect(isUnchanged(meta({}, { id: "other" }), fp)).toBe(false);
    expect(isUnchanged(meta({}, { url: "https://data.gov.ua/x/uo2.zip" }), fp)).toBe(false);
    expect(isUnchanged(meta({}, { last_modified: "2026-09-01" }), fp)).toBe(false);
    expect(isUnchanged(meta({}), { ...fp, last_modified: null })).toBe(false);
  });

  it("re-syncs anything older than 7 days, also resources without last_modified", () => {
    const old = new Date(Date.now() - WEEK - 1000).toISOString();
    expect(isUnchanged(meta({ synced_at: old }), fp)).toBe(false);
    const noDate = { ...fp, last_modified: undefined };
    expect(isUnchanged(meta({}, { last_modified: null }), noDate)).toBe(true);
    expect(isUnchanged(meta({ synced_at: old }, { last_modified: null }), noDate)).toBe(false);
    expect(isUnchanged(meta({ synced_at: "garbage" }), fp)).toBe(false);
  });
});

describe("assertAllowedDownloadUrl", () => {
  it("accepts only HTTPS on data.gov.ua and *.gov.ua", () => {
    expect(assertAllowedDownloadUrl("https://data.gov.ua/d/x.zip").hostname).toBe("data.gov.ua");
    expect(assertAllowedDownloadUrl("https://DATA.GOV.UA/d/x.zip").hostname).toBe("data.gov.ua");
    expect(assertAllowedDownloadUrl("https://nais.gov.ua/x.zip").hostname).toBe("nais.gov.ua");
    for (const bad of [
      "http://data.gov.ua/d/x.zip",
      "https://data.gov.ua.evil.com/x.zip",
      "https://evilgov.ua/x.zip",
      "https://cdn.example.com/x.zip",
      "ftp://data.gov.ua/x.zip",
      "not a url",
    ]) {
      expect(() => assertAllowedDownloadUrl(bad)).toThrow(/download refused/);
    }
  });
});

describe("sync lock", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mirror-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes its PID, refuses while the owner is alive, and releases", async () => {
    const unlock = await lockMirror(dir);
    expect((await readFile(join(dir, ".sync.lock"), "utf8")).trim()).toBe(String(process.pid));
    // Pretend a live process (our parent) owns it.
    await writeFile(join(dir, ".sync.lock"), String(process.ppid));
    await expect(lockMirror(dir)).rejects.toBeInstanceOf(MirrorLockedError);
    await unlock();
    expect(await readdir(dir)).toEqual([]);
  });

  it("takes over a lock left by a dead process", async () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    await writeFile(join(dir, ".sync.lock"), String(dead));
    const unlock = await lockMirror(dir);
    expect((await readFile(join(dir, ".sync.lock"), "utf8")).trim()).toBe(String(process.pid));
    await unlock();
  });
});

describe("mirror trimming", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mirror-trim-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("stores only key, text and kept columns, with long values capped", async () => {
    const spec = {
      format: "xml" as const,
      exact: ["EDRPOU"],
      text: ["NAME"],
      keep: ["STAN", "FOUNDERS"],
    };
    const w = await MirrorWriter.create(dir, "t", spec);
    w.add({
      NAME: "ТОВ А",
      EDRPOU: "01234567",
      STAN: "зареєстровано",
      STATUTE: "boilerplate",
      FOUNDERS: "Ф".repeat(5000),
    });
    await w.commit({ registry: "t", dataset: "d", resources: [], row_count: 1, synced_at: "now" });
    const reader = new MirrorReader(dir);
    const [row] = (await reader.lookup("t", "01234567", 1))!.rows;
    reader.close();
    expect(Object.keys(row!).sort()).toEqual(["EDRPOU", "FOUNDERS", "NAME", "STAN"]);
    expect(row!.FOUNDERS!.length).toBe(2001);
  });

  it("applies column transforms before storing", async () => {
    const w = await MirrorWriter.create(dir, "t", {
      format: "xml",
      exact: [],
      text: ["NAME"],
      keep: ["ADDRESS"],
      transform: { ADDRESS: settlementOnly },
    });
    w.add({ NAME: "ІВАНЕНКО ІВАН", ADDRESS: "Україна, 01001, м. Київ, вул. Хрещатик, буд. 1" });
    await w.commit({ registry: "t", dataset: "d", resources: [], row_count: 1, synced_at: "now" });
    const reader = new MirrorReader(dir);
    const [row] = (await reader.lookup("t", "іваненко", 1))!.rows;
    reader.close();
    expect(row!.ADDRESS).toBe("Україна, 01001, м. Київ");
  });

  it("prunes only mirror-named files, only in a directory marked as ours", async () => {
    const files = [
      "edr-uo.sqlite",
      "debtors.sqlite",
      "debtors.sqlite.tmp",
      "debtors.download",
      "notes.txt",
      "old_copy.sqlite", // underscore: not a name we write
      "backup.sqlite.bak",
    ];
    for (const f of files) await writeFile(join(dir, f), "");
    const log = createLogger({ logLevel: "error" });
    await pruneMirror(dir, ["edr-uo"], log);
    expect((await readdir(dir)).sort()).toEqual([...files].sort()); // no sentinel: untouched
    await writeFile(join(dir, SENTINEL), "");
    await pruneMirror(dir, ["edr-uo"], log);
    expect((await readdir(dir)).sort()).toEqual(
      [SENTINEL, "edr-uo.sqlite", "notes.txt", "old_copy.sqlite", "backup.sqlite.bak"].sort(),
    );
  });

  it("the writer marks the directory on first run", async () => {
    const w = await MirrorWriter.create(dir, "t", { format: "csv", exact: [], text: [] });
    await w.abort();
    expect(await readdir(dir)).toContain(SENTINEL);
  });
});
