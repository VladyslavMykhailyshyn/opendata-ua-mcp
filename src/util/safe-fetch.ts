/**
 * SSRF-safe capped download. Resource URLs on data.gov.ua are written by
 * publishers, so every hop is resolved here, checked against private/internal
 * address ranges and then pinned: the connection goes to exactly the address
 * that passed the check (no second lookup, no DNS rebinding window).
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { ToolError } from "./errors.js";

export interface DownloadResult {
  buffer: Buffer;
  bytes: number;
  truncated: boolean;
  contentType?: string;
  /** URL the body came from, after redirects. */
  finalUrl: string;
}

export interface SafeFetchOptions {
  /** Tests only: let the download reach 127.0.0.1 / ::1. Other private ranges stay refused. */
  allowLoopback?: boolean;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BAD_ADDRESS = "Недопустима адреса ресурсу.";

function abortError(message: string): Error {
  return new DOMException(message, "AbortError");
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number];
  return (
    a === 0 || // unspecified / "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function parseIpv4(ip: string): number[] | undefined {
  if (!net.isIPv4(ip)) return undefined;
  return ip.split(".").map(Number);
}

function isLoopback(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return v4[0] === 127;
  const g = parseIpv6(ip);
  return !!g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
}

/** Expand an IPv6 literal into its eight 16-bit groups. */
function parseIpv6(ip: string): number[] | undefined {
  let s = ip.replace(/%.*$/, "");
  if (!net.isIPv6(s)) return undefined;
  // Embedded dotted IPv4 (::ffff:10.0.0.1) becomes the last two groups.
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return undefined;
    const [a, b, c, d] = v4 as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const left = head ? head.split(":").map((g) => parseInt(g, 16)) : [];
  const right = tail ? tail.split(":").map((g) => parseInt(g, 16)) : [];
  const groups = [
    ...left,
    ...new Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0),
    ...right,
  ];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

function ipv4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * True for any address a download must never reach: loopback, RFC1918,
 * link-local, CGNAT, unique-local, unspecified, multicast — and IPv6 forms
 * that embed such an IPv4 (mapped, NAT64, 6to4, deprecated compatible).
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPrivateIpv4(v4);
  const g = parseIpv6(ip);
  if (!g) return true; // unparseable — refuse rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const first6Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (first6Zero && g5 === 0) {
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
    return isPrivateIpv4(ipv4FromGroups(g6, g7)); // ::a.b.c.d (deprecated)
  }
  if (first6Zero && g5 === 0xffff) return isPrivateIpv4(ipv4FromGroups(g6, g7)); // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4(ipv4FromGroups(g6, g7)); // NAT64
  }
  if (g0 === 0x2002) return isPrivateIpv4(ipv4FromGroups(g1, g2)); // 6to4
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(BAD_ADDRESS);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError(BAD_ADDRESS);
  return url;
}

/** Resolve the host and refuse unless every address is public. */
async function resolveChecked(url: URL, opts: SafeFetchOptions): Promise<dns.LookupAddress[]> {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let addresses: dns.LookupAddress[];
  const literal = net.isIP(host);
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await dns.promises.lookup(host, { all: true });
    } catch {
      throw new ToolError("Не вдалося визначити адресу джерела.");
    }
  }
  if (addresses.length === 0) throw new ToolError(BAD_ADDRESS);
  const refused = (ip: string) => isPrivateAddress(ip) && !(opts.allowLoopback && isLoopback(ip));
  if (addresses.some((a) => refused(a.address))) throw new ToolError(BAD_ADDRESS);
  return addresses;
}

/** A `lookup` that hands the socket the already-checked addresses and nothing else. */
function pinnedLookup(addresses: dns.LookupAddress[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6 ? options.family : undefined;
    const matching = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    const list = matching.length ? matching : addresses;
    if (options.all) {
      callback(null, list);
    } else {
      const first = list[0]!;
      callback(null, first.address, first.family);
    }
  };
}

function openRequest(
  url: URL,
  addresses: dns.LookupAddress[],
  userAgent: string,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": userAgent, "accept-encoding": "gzip, deflate, br" },
        lookup: pinnedLookup(addresses),
        agent: false, // one fresh, pinned connection per hop — no pooled socket reuse
        signal,
      },
      resolve,
    );
    req.on("error", (err) => {
      reject(
        signal.aborted || err.name === "AbortError"
          ? abortError("download aborted")
          : new ToolError("Не вдалося з'єднатися з джерелом."),
      );
    });
    req.end();
  });
}

function decompressed(res: http.IncomingMessage): Readable {
  const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
  let inflater: zlib.Gzip | zlib.Inflate | zlib.BrotliDecompress | undefined;
  if (encoding === "gzip" || encoding === "x-gzip") inflater = zlib.createGunzip();
  else if (encoding === "deflate") inflater = zlib.createInflate();
  else if (encoding === "br") inflater = zlib.createBrotliDecompress();
  if (!inflater) return res;
  res.on("error", (err) => inflater.destroy(err));
  return res.pipe(inflater);
}

/** Read the body up to `maxBytes` of decompressed data; stop the transfer past that. */
function readCapped(
  res: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
  finalUrl: string,
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const contentType = res.headers["content-type"];
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      res.destroy();
      settle(() => reject(abortError("download aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const stream = decompressed(res);
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (total + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - total));
        total = maxBytes;
        res.destroy();
        settle(() =>
          resolve({
            buffer: Buffer.concat(chunks),
            bytes: total,
            truncated: true,
            contentType,
            finalUrl,
          }),
        );
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    stream.on("end", () =>
      settle(() =>
        resolve({
          buffer: Buffer.concat(chunks),
          bytes: total,
          truncated: false,
          contentType,
          finalUrl,
        }),
      ),
    );
    const onError = () =>
      settle(() => reject(new ToolError("Помилка під час читання відповіді джерела.")));
    stream.on("error", onError);
    res.on("error", onError);
    res.on("aborted", onError);
  });
}

/**
 * Download `url` with a hard cap on decompressed bytes. Follows up to 5
 * redirects, checking each hop. Non-2xx, private targets and transport
 * failures throw `ToolError`; the deadline or `signal` throws an AbortError.
 */
export async function downloadCapped(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  opts: SafeFetchOptions = {},
): Promise<DownloadResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(abortError("download timed out")), timeoutMs);
  const combined = signal ? AbortSignal.any([ac.signal, signal]) : ac.signal;
  try {
    let current = parseUrl(url);
    for (let hop = 0; ; hop++) {
      if (combined.aborted) throw abortError("download aborted");
      const addresses = await resolveChecked(current, opts);
      const res = await openRequest(current, addresses, userAgent, combined);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new ToolError("Забагато перенаправлень.");
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new ToolError(BAD_ADDRESS);
        }
        current = parseUrl(next.href);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw new ToolError(`Джерело відповіло HTTP ${status}.`);
      }
      return await readCapped(res, maxBytes, combined, current.href);
    }
  } finally {
    clearTimeout(timer);
  }
}
