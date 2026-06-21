import { describe, it, expect } from "vitest";
import { parseCsv, parseJsonTable, parseXmlTable } from "../../src/util/csv.js";

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
