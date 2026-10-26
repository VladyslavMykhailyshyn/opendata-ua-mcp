import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";
import { DelimitedReader, MAX_COLUMNS } from "./delimited.js";
import { ToolError } from "./errors.js";

export { MAX_COLUMNS };

export interface ParsedTable {
  columns: { col: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** The parser stopped counting (spreadsheet row limit): rowCount is "at least". */
  rowCountIsLowerBound?: boolean;
  /** Columns beyond MAX_COLUMNS that were ignored. */
  droppedColumns?: number;
  /** Lines discarded by the CSV reader (oversized record, quote never closed). */
  droppedRows?: number;
}

/**
 * Rows parsed into objects beyond the preview: enough for type inference,
 * small enough that a 10 MB file costs no more than its line scan.
 */
export function sampleSize(previewLimit: number): number {
  return previewLimit + 1000;
}

/**
 * Declared inflated total of an office container (XLSX/ODS are ZIPs) above
 * which we do not hand it to SheetJS, which inflates whole parts in memory.
 */
const MAX_OFFICE_INFLATED_BYTES = 256 * 1024 * 1024;

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

/** Keep at most MAX_COLUMNS keys of a record (user-controlled JSON/XML). */
function capKeys(row: unknown): { row: Record<string, unknown>; dropped: number } {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return { row: { value: row }, dropped: 0 };
  }
  const keys = Object.keys(row);
  if (keys.length <= MAX_COLUMNS) return { row: row as Record<string, unknown>, dropped: 0 };
  const out: Record<string, unknown> = {};
  for (const k of keys.slice(0, MAX_COLUMNS)) out[k] = (row as Record<string, unknown>)[k];
  return { row: out, dropped: keys.length - MAX_COLUMNS };
}

/** Build the table from an already-bounded sample; types come from the sample only. */
function summarize(
  sample: Record<string, unknown>[],
  previewLimit: number,
  rowCount: number,
): ParsedTable {
  const columns: { col: string; type: string }[] = [];
  if (sample.length > 0) {
    for (const col of Object.keys(sample[0]!).slice(0, MAX_COLUMNS)) {
      columns.push({ col, type: inferType(sample.map((r) => r[col])) });
    }
  }
  return { columns, rows: sample.slice(0, previewLimit), rowCount };
}

/** Sample the first rows of a record list as objects and only count the rest. */
function sampleRecords(records: unknown[], previewLimit: number): ParsedTable {
  const sample: Record<string, unknown>[] = [];
  let droppedColumns = 0;
  for (const r of records.slice(0, sampleSize(previewLimit))) {
    const capped = capKeys(r);
    sample.push(capped.row);
    droppedColumns = Math.max(droppedColumns, capped.dropped);
  }
  const table = summarize(sample, previewLimit, records.length);
  if (droppedColumns) table.droppedColumns = droppedColumns;
  return table;
}

export function parseCsv(text: string, previewLimit: number): ParsedTable {
  const reader = new DelimitedReader();
  const sampleMax = sampleSize(previewLimit);
  const sample: Record<string, unknown>[] = [];
  let rowCount = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (sample.length < sampleMax) {
      const row = reader.push(line);
      if (row) {
        sample.push(row);
        rowCount++;
      }
    } else if (reader.count(line)) {
      rowCount++;
    }
  }
  const table = summarize(sample, previewLimit, rowCount);
  if (reader.droppedColumns) table.droppedColumns = reader.droppedColumns;
  if (reader.dropped) table.droppedRows = reader.dropped;
  return table;
}

/** Refuse office containers whose central directory declares a huge inflated size. */
function assertOfficeContainerSane(buffer: Buffer): void {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return;
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return; // not a readable ZIP — let SheetJS produce its own failure
  }
  let total = 0;
  for (const e of zip.getEntries()) total += e.header.size;
  if (total > MAX_OFFICE_INFLATED_BYTES) throw new ToolError("Файл завеликий для розбору.");
}

export function parseXlsx(buffer: Buffer, previewLimit: number): ParsedTable {
  assertOfficeContainerSane(buffer);
  const sampleMax = sampleSize(previewLimit);
  const wb = XLSX.read(buffer, {
    type: "buffer",
    sheets: 0,
    sheetRows: sampleMax + 1, // header + sample
    nodim: true, // the <dimension> tag is publisher-controlled; range from real cells
    dense: true,
    cellFormula: false,
    cellHTML: false,
    cellText: false,
    cellNF: false,
  });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { columns: [], rows: [], rowCount: 0 };
  const sheet = wb.Sheets[sheetName]!;
  const ref = sheet["!ref"];
  if (!ref) return { columns: [], rows: [], rowCount: 0 };
  const range = XLSX.utils.decode_range(ref);
  const droppedColumns = Math.max(0, range.e.c - range.s.c + 1 - MAX_COLUMNS);
  range.e.c = Math.min(range.e.c, range.s.c + MAX_COLUMNS - 1);
  range.e.r = Math.min(range.e.r, range.s.r + sampleMax);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, range });
  const table = summarize(rows, previewLimit, rows.length);
  // The read stopped at sheetRows: a full sample means there may be more rows.
  if (rows.length >= sampleMax) table.rowCountIsLowerBound = true;
  if (droppedColumns) table.droppedColumns = droppedColumns;
  return table;
}

export function parseJsonTable(text: string, previewLimit: number): ParsedTable {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // A truncated download is invalid JSON as a whole, but every record before
    // the cut is intact — recover those instead of failing the preview.
    const salvaged = scanJsonRecords(text, sampleSize(previewLimit));
    if (salvaged.count === 0) throw err;
    const table = sampleRecords(salvaged.rows, previewLimit);
    table.rowCount = salvaged.count;
    return table;
  }
  const records: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { result?: unknown }).result)
      ? (data as { result: unknown[] }).result
      : [data];
  return sampleRecords(records, previewLimit);
}

/**
 * Recover complete objects from the first array of objects in a (possibly
 * truncated) JSON text. Scans with string/escape awareness and stops at the
 * first incomplete object.
 */
export function salvageJsonRecords(text: string): Record<string, unknown>[] {
  return scanJsonRecords(text, Infinity).rows;
}

/** Same scan; only the first `maxRows` records are parsed, the rest are counted. */
function scanJsonRecords(
  text: string,
  maxRows: number,
): { rows: Record<string, unknown>[]; count: number } {
  const rows: Record<string, unknown>[] = [];
  let count = 0;
  const arrayStart = text.search(/\[\s*\{/);
  if (arrayStart < 0) return { rows, count };
  let i = text.indexOf("{", arrayStart);
  while (i >= 0 && i < text.length) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= text.length) break; // object cut off by truncation
    if (rows.length < maxRows) {
      try {
        rows.push(JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>);
      } catch {
        break;
      }
    }
    count++;
    let k = j + 1;
    while (k < text.length && (text[k] === "," || /\s/.test(text[k]!))) k++;
    if (text[k] !== "{") break; // end of the array
    i = k;
  }
  return { rows, count };
}

/** Find the largest array of object-records anywhere in a parsed structure. */
function largestRecordArray(
  node: unknown,
  best: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
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
  // Flatten one level (sample only) so nested objects don't blow up the preview.
  const flat = rows.slice(0, sampleSize(previewLimit)).map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v && typeof v === "object" ? JSON.stringify(v) : v;
    }
    return out;
  });
  const table = sampleRecords(flat, previewLimit);
  table.rowCount = rows.length;
  return table;
}
