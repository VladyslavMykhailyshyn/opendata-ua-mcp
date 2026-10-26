import { describe, it, expect } from "vitest";
import { parseCsv, parseJsonTable, parseXmlTable } from "../../src/util/csv.js";
import { DelimitedReader, MAX_COLUMNS } from "../../src/util/delimited.js";

describe("parseCsv", () => {
  it("infers column types and caps preview", () => {
    const csv = "name,year,amount\nКиїв,2024,100\nЛьвів,2023,200\nОдеса,2024,300";
    const t = parseCsv(csv, 2);
    expect(t.rowCount).toBe(3);
    expect(t.rows).toHaveLength(2);
    const types = Object.fromEntries(t.columns.map((c) => [c.col, c.type]));
    expect(types.year).toBe("number");
    expect(types.name).toBe("text");
  });
});

describe("parseJsonTable", () => {
  it("handles top-level array", () => {
    const t = parseJsonTable('[{"a":1},{"a":2}]', 10);
    expect(t.rowCount).toBe(2);
  });
  it("unwraps {result:[...]}", () => {
    const t = parseJsonTable('{"result":[{"a":1}]}', 10);
    expect(t.rowCount).toBe(1);
  });
});

describe("parseXmlTable", () => {
  it("finds the largest record array in nested XML", () => {
    const xml =
      "<root><records><row><name>Київ</name><year>2024</year></row>" +
      "<row><name>Львів</name><year>2023</year></row></records></root>";
    const t = parseXmlTable(xml, 10);
    expect(t.rowCount).toBe(2);
    expect(t.columns.map((c) => c.col).sort()).toEqual(["name", "year"]);
  });
});

describe("parseCsv on malformed gov exports", () => {
  it("keeps unescaped inner quotes inside the field (VAT payers register)", () => {
    const csv = '"name";"kod_pdv"\r\n"ТОВ "ЗОНТА-ТРАНС"";"356383613199"\r\n';
    const t = parseCsv(csv, 5);
    expect(t.rows).toEqual([{ name: 'ТОВ "ЗОНТА-ТРАНС"', kod_pdv: "356383613199" }]);
  });

  it("joins a quoted field that spans lines", () => {
    const csv = 'name;note\n"Київ";"перший\nдругий рядок"\n"Львів";"ок"\n';
    const t = parseCsv(csv, 5);
    expect(t.rows).toEqual([
      { name: "Київ", note: "перший\nдругий рядок" },
      { name: "Львів", note: "ок" },
    ]);
    expect(t.droppedRows).toBeUndefined();
  });

  it("counts rows past the sample without building them", () => {
    const csv = `a;b\n${"1;2\n".repeat(3000)}`;
    const t = parseCsv(csv, 10);
    expect(t.rowCount).toBe(3000);
    expect(t.rows).toHaveLength(10);
    expect(t.columns.map((c) => c.type)).toEqual(["number", "number"]);
  });
});

describe("DelimitedReader", () => {
  it("drops a record whose quote never closes after 50 lines and reports it", () => {
    const reader = new DelimitedReader();
    reader.push("a;b");
    expect(reader.push('"open;1')).toBeUndefined();
    for (let i = 0; i < 48; i++) expect(reader.push("x;y")).toBeUndefined();
    expect(reader.push("x;y")).toBeUndefined(); // 50th line: give up
    expect(reader.dropped).toBe(50);
    expect(reader.push("1;2")).toEqual({ a: "1", b: "2" });
  });

  it("exposes the header and drops columns past MAX_COLUMNS", () => {
    const reader = new DelimitedReader();
    reader.push(Array.from({ length: 600 }, (_, i) => `c${i}`).join(","));
    expect(reader.header).toBeUndefined();
    const row = reader.push(Array.from({ length: 600 }, (_, i) => String(i)).join(","))!;
    expect(reader.header).toHaveLength(MAX_COLUMNS);
    expect(reader.droppedColumns).toBe(100);
    expect(Object.keys(row)).toHaveLength(MAX_COLUMNS);
    expect(row.c499).toBe("499");
  });

  it("counts a quoted multi-line record in count() like push() would", () => {
    const reader = new DelimitedReader();
    reader.push("a;b");
    reader.push("1;2");
    expect(reader.count('"x')).toBe(false);
    expect(reader.count('y";3')).toBe(true);
    expect(reader.count("")).toBe(false);
    expect(reader.count("4;5")).toBe(true);
  });
});
