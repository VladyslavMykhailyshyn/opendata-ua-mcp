// The byte-capped, SSRF-checked downloader lives in safe-fetch.ts; callers
// keep importing it from here. Always returns the raw buffer — callers decode
// (see decodeText) because data.gov.ua files come in mixed encodings.
export { downloadCapped, type DownloadResult, type SafeFetchOptions } from "./safe-fetch.js";

/**
 * Decode a text buffer with charset detection. Ukrainian gov CSVs are commonly
 * Windows-1251, not UTF-8 — a naive utf-8 decode yields mojibake. We honor an
 * explicit charset, else try strict UTF-8 and fall back to Windows-1251.
 */
export function decodeText(buffer: Buffer, contentType?: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  const tryDecode = (enc: string, fatal: boolean): string | null => {
    try {
      return new TextDecoder(enc, { fatal }).decode(buffer);
    } catch {
      return null;
    }
  };

  if (declared && declared !== "utf-8" && declared !== "utf8") {
    return tryDecode(declared, false) ?? new TextDecoder("windows-1251").decode(buffer);
  }
  // Default/utf-8: strict-decode to detect invalid byte sequences, else cp1251.
  return tryDecode("utf-8", true) ?? new TextDecoder("windows-1251").decode(buffer);
}

/**
 * A byte-capped download ends mid-row and often mid-character: a split UTF-8
 * sequence fails strict decoding and the text falls back to Windows-1251
 * (mojibake). Cutting at the last newline fixes both — "
" is ASCII and never
 * occurs inside a multi-byte UTF-8 or Windows-1251 sequence.
 */
export function trimToLastLine(buffer: Buffer): Buffer {
  const nl = buffer.lastIndexOf(0x0a);
  return nl > 0 ? buffer.subarray(0, nl + 1) : buffer;
}
