export interface DownloadResult {
  buffer: Buffer;
  bytes: number;
  truncated: boolean;
  contentType?: string;
}

/**
 * Download a resource file with a hard byte cap. Uses global fetch (follows
 * redirects). Always returns the raw buffer — callers decode (see decodeText)
 * because data.gov.ua files come in mixed encodings (UTF-8, Windows-1251).
 */
export async function downloadCapped(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  userAgent: string,
): Promise<DownloadResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": userAgent },
      redirect: "follow",
      signal: ac.signal,
    });
    const contentType = res.headers.get("content-type") ?? undefined;
    if (!res.body) return { buffer: Buffer.alloc(0), bytes: 0, truncated: false, contentType };

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      if (total + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
    return { buffer: Buffer.concat(chunks), bytes: total, truncated, contentType };
  } finally {
    clearTimeout(timer);
  }
}

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
