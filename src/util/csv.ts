import Papa from "papaparse";
import * as XLSX from "xlsx";

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
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
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
