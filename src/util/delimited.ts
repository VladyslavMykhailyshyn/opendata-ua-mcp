/**
 * Tolerant reader for the delimited text files on data.gov.ua. Shared by the
 * preview parser and the registry mirror. Handles what papaparse doesn't:
 * unescaped inner quotes (`"ТОВ "ЗОНТА-ТРАНС"";…`) and a header written with
 * a different delimiter than the rows (debtors register: ";" vs ",").
 */

const CANDIDATES = [";", "\t", ",", "|"];

/** Delimiter occurrences outside quoted fields. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) n++;
  }
  return n;
}

export function sniffDelimiter(line: string): string {
  let best = CANDIDATES[0]!;
  let bestCount = -1;
  for (const d of CANDIDATES) {
    const n = countOutsideQuotes(line, d);
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Parse one CSV record that may span lines. Tolerant of the unescaped inner
 * quotes common in gov exports (`"ТОВ "ЗОНТА-ТРАНС"";…`): a quote closes a
 * field only when the quote run is followed by a delimiter or end of line.
 * Returns undefined when a quoted field is still open at end of input.
 */
export function parseCsvRecord(line: string, delimiter: string): string[] | undefined {
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let value = "";
    if (line[i] === '"') {
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line[i]!;
        if (c !== '"') {
          value += c;
          i++;
          continue;
        }
        let run = 0;
        while (line[i + run] === '"') run++;
        const after = line[i + run];
        if (after === undefined || after === delimiter) {
          value += '"'.repeat(Math.ceil((run - 1) / 2));
          i += run;
          closed = true;
          break;
        }
        value += '"'.repeat(Math.ceil(run / 2));
        i += run;
      }
      if (!closed) return undefined;
    } else {
      const end = line.indexOf(delimiter, i);
      value = line.slice(i, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end;
    }
    fields.push(value.trim());
    if (i >= line.length) return fields;
    i++; // skip delimiter
    if (i === line.length) {
      fields.push("");
      return fields;
    }
  }
}

// A record whose quoted field never closes would swallow the rest of the file.
const MAX_RECORD_LINES = 50;
// ... and a single huge "line" would be re-parsed on every continuation.
const MAX_PENDING_CHARS = 1_000_000;
/** Header cells beyond this are ignored (files are user-controlled). */
export const MAX_COLUMNS = 500;

/** Feed physical lines; get a column→value record each time one completes. */
export class DelimitedReader {
  private headerLine: string | undefined;
  private columns: string[] | undefined;
  private delimiter = ";";
  private pending = "";
  private pendingLines = 0;
  /** Physical lines discarded: oversized records or quotes that never closed. */
  dropped = 0;
  /** Header cells past MAX_COLUMNS that were ignored. */
  droppedColumns = 0;

  get header(): string[] | undefined {
    return this.columns;
  }

  push(line: string): Record<string, string> | undefined {
    const fields = this.feed(line);
    if (!fields) return undefined;
    const row: Record<string, string> = {};
    this.columns!.forEach((col, idx) => {
      row[col] = fields[idx] ?? "";
    });
    return row;
  }

  /**
   * Scan a line without building a row; true when it completes a record.
   * Lets callers count a 10 MB file after they have the rows they want.
   */
  count(line: string): boolean {
    if (this.columns && this.pendingLines === 0 && !line.includes('"')) {
      return line.trim() !== "";
    }
    return this.feed(line) !== undefined;
  }

  private feed(line: string): string[] | undefined {
    if (this.headerLine === undefined) {
      const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line; // BOM
      if (clean.trim()) this.headerLine = clean;
      return undefined;
    }
    if (!this.columns) this.readHeader(line);

    if (this.pending.length + line.length > MAX_PENDING_CHARS) {
      this.dropped += this.pendingLines + 1;
      this.reset();
      return undefined;
    }
    const continuing = this.pendingLines > 0;
    this.pending = continuing ? `${this.pending}\n${line}` : line;
    this.pendingLines++;
    // An open quoted field can only close on a line that contains a quote.
    if (continuing && !line.includes('"')) {
      if (this.pendingLines < MAX_RECORD_LINES) return undefined;
      this.dropped += this.pendingLines;
      this.reset();
      return undefined;
    }
    const fields = parseCsvRecord(this.pending, this.delimiter);
    if (!fields) {
      if (this.pendingLines < MAX_RECORD_LINES) return undefined;
      this.dropped += this.pendingLines;
      this.reset();
      return undefined;
    }
    this.reset();
    if (fields.length === 1 && fields[0] === "") return undefined;
    return fields;
  }

  private reset(): void {
    this.pending = "";
    this.pendingLines = 0;
  }

  /** Decide delimiters once the first data line is known. */
  private readHeader(firstDataLine: string): void {
    const headerLine = this.headerLine!;
    const headerDelimiter = sniffDelimiter(headerLine);
    const columns = countOutsideQuotes(headerLine, headerDelimiter);
    // Rows usually share the header's delimiter; only re-sniff when they don't
    // fit it, and only trust the re-sniff when the line actually shows one
    // (a line that opens a multi-line quoted field shows none).
    const sniffed = sniffDelimiter(firstDataLine);
    this.delimiter =
      countOutsideQuotes(firstDataLine, headerDelimiter) === columns ||
      countOutsideQuotes(firstDataLine, sniffed) === 0
        ? headerDelimiter
        : sniffed;
    const all = parseCsvRecord(headerLine, headerDelimiter) ?? headerLine.split(headerDelimiter);
    this.columns = all.slice(0, MAX_COLUMNS);
    this.droppedColumns = all.length - this.columns.length;
  }
}
