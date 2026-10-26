import type { Readable } from "node:stream";
import { trimToLastLine } from "../util/download.js";
import { DelimitedReader } from "../util/delimited.js";

export type Row = Record<string, string>;

/**
 * Decode a byte stream to text chunks. Registries come in UTF-8 or
 * Windows-1251; XML declares its encoding, CSV is sniffed on the first 64 KB.
 */
export async function* decodeStream(bytes: Readable): AsyncGenerator<string> {
  let decoder: InstanceType<typeof TextDecoder> | undefined;
  let head = Buffer.alloc(0);
  for await (const chunk of bytes as AsyncIterable<Buffer>) {
    if (!decoder) {
      head = Buffer.concat([head, chunk]);
      if (head.length < 65536) continue;
      decoder = new TextDecoder(sniffEncoding(head));
      yield decoder.decode(head, { stream: true });
      continue;
    }
    yield decoder.decode(chunk, { stream: true });
  }
  if (!decoder) {
    decoder = new TextDecoder(sniffEncoding(head));
    yield decoder.decode(head, { stream: true });
  }
  yield decoder.decode();
}

export function sniffEncoding(head: Buffer): string {
  const declared = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head.toString("latin1", 0, 200));
  if (declared) return declared[1]!.toLowerCase();
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(trimToLastLine(head));
    return "utf-8";
  } catch {
    return "windows-1251";
  }
}

// A line or record that never ends (binary garbage, a missing closing tag)
// must not grow the buffer until the sync is OOM-killed.
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

/** Split a text stream into lines (LF or CRLF). */
async function* lines(text: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of text) {
    rest += chunk;
    let start = 0;
    let nl: number;
    while ((nl = rest.indexOf("\n", start)) >= 0) {
      yield rest.slice(start, nl > start && rest[nl - 1] === "\r" ? nl - 1 : nl);
      start = nl + 1;
    }
    rest = rest.slice(start);
    if (rest.length > MAX_BUFFER_CHARS) throw new Error("line longer than 16 MB (not a text file?)");
  }
  if (rest) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
}

export interface CsvRowsOptions {
  /** Called once at the end with the number of malformed records skipped. */
  onDropped?: (count: number) => void;
}

export async function* csvRows(
  text: AsyncIterable<string>,
  opts: CsvRowsOptions = {},
): AsyncGenerator<Row> {
  const reader = new DelimitedReader();
  for await (const line of lines(text)) {
    const fields = reader.push(line);
    if (!fields) continue;
    const row: Row = {};
    for (const [col, v] of Object.entries(fields)) {
      if (v !== "" && v !== "null") row[col] = v;
    }
    yield row;
  }
  // The reader may or may not count what it dropped; report it when it does.
  if (opts.onDropped && "dropped" in reader && typeof reader.dropped === "number") {
    opts.onDropped(reader.dropped);
  }
}

/**
 * Yield one flat row per `<tag>…</tag>` block. Nested elements (founders,
 * signers) become "; "-joined text so every column stays a string.
 *
 * Hand-rolled instead of fast-xml-parser: registry records are flat with one
 * level of nesting, and a generic parser managed ~2.5k real ЄДР records/s
 * (an hour per sync); this is I/O-bound.
 */
export async function* xmlRows(text: AsyncIterable<string>, tag: string): AsyncGenerator<Row> {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let buf = "";
  for await (const chunk of text) {
    const scanned = buf.length;
    buf += chunk;
    let start = buf.indexOf(open);
    while (start >= 0) {
      // The previous pass already searched the old buffer, so a closing tag
      // can only begin in the new chunk (or straddle the seam).
      const end = buf.indexOf(close, Math.max(start + open.length, scanned - close.length));
      if (end < 0) break;
      yield flatRecord(buf.slice(start + open.length, end));
      start = buf.indexOf(open, end + close.length);
    }
    // Keep only the unfinished block (or a tail that may hold a split tag).
    buf = start >= 0 ? buf.slice(start) : buf.slice(-open.length);
    if (buf.length > MAX_BUFFER_CHARS) {
      throw new Error(`<${tag}> record longer than 16 MB without ${close}`);
    }
  }
}

// A child element: self-closing, or with content up to its own closing tag.
const CHILD = /<([\w.-]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
const TAG = /<[^>]*>/;

export function flatRecord(inner: string): Row {
  const row: Row = {};
  for (const m of inner.matchAll(CHILD)) {
    const content = m[2];
    if (!content) continue;
    const text = content.includes("<")
      ? content
          .split(TAG)
          .map((p) => decodeEntities(p).trim())
          .filter(Boolean)
          .join("; ")
      : decodeEntities(content).trim();
    if (text) row[m[1]!] = text;
  }
  return row;
}

const NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[\da-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (whole, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return isCodePoint(code) ? String.fromCodePoint(code) : whole;
  });
}

// fromCodePoint throws outside the Unicode range; lone surrogates would make
// the stored JSON invalid UTF-8.
const isCodePoint = (n: number) =>
  Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
