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

/** Feed physical lines; get a column→value record each time one completes. */
export class DelimitedReader {
  private headerLine: string | undefined;
  private header: string[] | undefined;
  private delimiter = ";";
  private pending = "";
  private pendingLines = 0;

  push(line: string): Record<string, string> | undefined {
    if (this.headerLine === undefined) {
      const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line; // BOM
      if (clean.trim()) this.headerLine = clean;
      return undefined;
    }
    if (!this.header) this.readHeader(line);

    this.pending = this.pendingLines ? `${this.pending}\n${line}` : line;
    this.pendingLines++;
    const fields = parseCsvRecord(this.pending, this.delimiter);
    if (!fields && this.pendingLines < MAX_RECORD_LINES) return undefined;
    this.pending = "";
    this.pendingLines = 0;
    if (!fields || (fields.length === 1 && fields[0] === "")) return undefined;

    const row: Record<string, string> = {};
    this.header!.forEach((col, idx) => {
      row[col] = fields[idx] ?? "";
    });
    return row;
  }

  /** Decide delimiters once the first data line is known. */
  private readHeader(firstDataLine: string): void {
    const headerLine = this.headerLine!;
    const headerDelimiter = sniffDelimiter(headerLine);
    const columns = countOutsideQuotes(headerLine, headerDelimiter);
    // Rows usually share the header's delimiter; only re-sniff when they don't fit it.
    this.delimiter =
      countOutsideQuotes(firstDataLine, headerDelimiter) === columns
        ? headerDelimiter
        : sniffDelimiter(firstDataLine);
    this.header = parseCsvRecord(headerLine, headerDelimiter) ?? headerLine.split(headerDelimiter);
  }
}
