import Papa from "papaparse";
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";

export interface ParsedTable {
  columns: { col: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

function inferType(values: unknown[]): string {
  let numeric = 0;
  let dateish = 0;
  let seen = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    seen++;
    const s = String(v).trim();
    if (s !== "" && !Number.isNaN(Number(s))) numeric++;
    else if (/^\d{4}-\d{2}-\d{2}/.test(s)) dateish++;
  }
  if (seen === 0) return "unknown";
  if (numeric / seen > 0.9) return "number";
  if (dateish / seen > 0.9) return "date";
  return "text";
}

function summarize(rows: Record<string, unknown>[], previewLimit: number): ParsedTable {
  const columns: { col: string; type: string }[] = [];
  if (rows.length > 0) {
    for (const col of Object.keys(rows[0]!)) {
      columns.push({ col, type: inferType(rows.map((r) => r[col])) });
    }
  }
  return { columns, rows: rows.slice(0, previewLimit), rowCount: rows.length };
}

/** Sniff the delimiter from the header line — Ukrainian CSVs often use ';'. */
function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") + 1 || text.length);
  const counts: Record<string, number> = {
    ";": (firstLine.match(/;/g) ?? []).length,
    ",": (firstLine.match(/,/g) ?? []).length,
    "\t": (firstLine.match(/\t/g) ?? []).length,
    "|": (firstLine.match(/\|/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0];
}

export function parseCsv(text: string, previewLimit: number): ParsedTable {
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimiter: sniffDelimiter(text),
  });
  return summarize(parsed.data, previewLimit);
}

export function parseXlsx(buffer: Buffer, previewLimit: number): ParsedTable {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { columns: [], rows: [], rowCount: 0 };
  const sheet = wb.Sheets[sheetName]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  return summarize(rows, previewLimit);
}

export function parseJsonTable(text: string, previewLimit: number): ParsedTable {
  const data = JSON.parse(text);
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { result?: unknown }).result)
      ? ((data as { result: Record<string, unknown>[] }).result)
      : [data as Record<string, unknown>];
  return summarize(rows, previewLimit);
}

/** Find the largest array of object-records anywhere in a parsed structure. */
function largestRecordArray(node: unknown, best: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (objs.length > best.length) best = objs as Record<string, unknown>[];
    for (const item of node) best = largestRecordArray(item, best);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) best = largestRecordArray(v, best);
  }
  return best;
}

export function parseXmlTable(text: string, previewLimit: number): ParsedTable {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const obj = parser.parse(text);
  const rows = largestRecordArray(obj);
  // Flatten one level so nested objects don't blow up the preview.
  const flat = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v && typeof v === "object" ? JSON.stringify(v) : v;
    }
    return out;
  });
  return summarize(flat, previewLimit);
}
