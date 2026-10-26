import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";
import { DelimitedReader } from "./delimited.js";

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

export function parseCsv(text: string, previewLimit: number): ParsedTable {
  const reader = new DelimitedReader();
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const row = reader.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (row) rows.push(row);
  }
  return summarize(rows, previewLimit);
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
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // A truncated download is invalid JSON as a whole, but every record before
    // the cut is intact — recover those instead of failing the preview.
    const salvaged = salvageJsonRecords(text);
    if (salvaged.length === 0) throw err;
    return summarize(salvaged, previewLimit);
  }
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { result?: unknown }).result)
      ? (data as { result: Record<string, unknown>[] }).result
      : [data as Record<string, unknown>];
  return summarize(rows, previewLimit);
}

/**
 * Recover complete objects from the first array of objects in a (possibly
 * truncated) JSON text. Scans with string/escape awareness and stops at the
 * first incomplete object.
 */
export function salvageJsonRecords(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const arrayStart = text.search(/\[\s*\{/);
  if (arrayStart < 0) return out;
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
    try {
      out.push(JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>);
    } catch {
      break;
    }
    let k = j + 1;
    while (k < text.length && (text[k] === "," || /\s/.test(text[k]!))) k++;
    if (text[k] !== "{") break; // end of the array
    i = k;
  }
  return out;
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
