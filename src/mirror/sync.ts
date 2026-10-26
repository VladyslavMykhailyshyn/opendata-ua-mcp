import { createWriteStream, createReadStream } from "node:fs";
import { access, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { packageShow } from "../ckan/actions.js";
import type { CkanClient } from "../ckan/client.js";
import type { CkanResource } from "../ckan/types.js";
import type { Logger } from "../util/logger.js";
import { pickBestResource } from "../util/resource-picker.js";
import type { MirrorSpec, RegistryDef } from "../registries.js";
import { csvRows, decodeStream, xmlRows, type Row } from "./records.js";
import { MirrorReader, MirrorWriter, SENTINEL, touchSentinel, type MirrorMeta } from "./store.js";
import { listZipEntries, openZipEntry } from "./zip-stream.js";

export interface SyncOptions {
  dir: string;
  userAgent: string;
  force?: boolean;
  /** Print the first rows instead of building (to fix column config). */
  inspect?: boolean;
  /** Stops the download and the row loop (SIGTERM from systemd). */
  signal?: AbortSignal;
}

export type SyncOutcome =
  | { status: "synced"; rows: number; seconds: number }
  | { status: "unchanged" }
  | { status: "inspected"; sample: Row[] };

// Full registries are hundreds of MB; the portal can be slow.
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
// A resource that never changes its last_modified is still refreshed weekly.
const MAX_UNCHANGED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A new export much smaller than the last one is a truncated download or a
// changed format, not a registry that shed a fifth of its records overnight.
const MIN_ROW_RATIO = 0.8;
// Rows between column checks and abort checks.
const COLUMN_SAMPLE_ROWS = 1000;
const ABORT_CHECK_ROWS = 10_000;

export async function syncRegistry(
  def: RegistryDef & { mirror: MirrorSpec },
  ckan: CkanClient,
  log: Logger,
  opts: SyncOptions,
): Promise<SyncOutcome> {
  const started = Date.now();
  const pkg = await packageShow(ckan, def.dataset);
  const resource = pickMirrorResource(pkg.resources ?? [], def.mirror);
  if (!resource?.url) throw new Error(`no resource matches the mirror spec in ${def.dataset}`);

  const fingerprint = { id: resource.id, url: resource.url, last_modified: resource.last_modified };
  let current: MirrorMeta | undefined;
  if (!opts.inspect) {
    const reader = new MirrorReader(opts.dir);
    current = await reader.meta(def.key).catch(() => undefined);
    reader.close();
    if (!opts.force && current && isUnchanged(current, fingerprint)) return { status: "unchanged" };
  }

  await mkdir(opts.dir, { recursive: true });
  await touchSentinel(opts.dir);
  const download = join(opts.dir, `${def.key}.download`);
  try {
    log.info("mirror download", { registry: def.key, resource: resource.id, url: resource.url });
    await downloadToFile(resource.url, download, opts.userAgent, opts.signal);
    const dropped = (n: number) => {
      if (n) log.warn("mirror dropped malformed rows", { registry: def.key, dropped: n });
    };
    const rows = await openRows(download, def.mirror, dropped);

    if (opts.inspect) {
      const sample: Row[] = [];
      for await (const row of rows) {
        sample.push(row);
        if (sample.length >= 3) break;
      }
      return { status: "inspected", sample };
    }

    const writer = await MirrorWriter.create(opts.dir, def.key, def.mirror);
    try {
      const checkColumns = () => {
        const { required, kept } = writer.missingColumns();
        if (required.length) {
          throw new Error(
            `columns ${required.join(", ")} not in the first ${writer.count} rows of the data`,
          );
        }
        if (kept.length) log.warn("mirror columns never seen", { registry: def.key, kept });
      };
      for await (const raw of rows) {
        const row = def.mirror.rename ? renameColumns(raw, def.mirror.rename) : raw;
        writer.add(row);
        if (writer.count === COLUMN_SAMPLE_ROWS) checkColumns();
        if (writer.count % ABORT_CHECK_ROWS === 0) opts.signal?.throwIfAborted();
        if (writer.count % 1_000_000 === 0) {
          log.info("mirror progress", { registry: def.key, rows: writer.count });
        }
      }
      if (writer.count === 0) throw new Error("no records parsed");
      if (writer.count < COLUMN_SAMPLE_ROWS) checkColumns();
      opts.signal?.throwIfAborted();
      if (!opts.force && current && writer.count < current.row_count * MIN_ROW_RATIO) {
        throw new Error(
          `only ${writer.count} rows parsed, previous sync had ${current.row_count}; ` +
            "keeping the old copy (use --force to replace it)",
        );
      }
      const meta: MirrorMeta = {
        registry: def.key,
        dataset: pkg.name,
        resources: [{ ...fingerprint, name: resource.name }],
        row_count: writer.count,
        synced_at: new Date().toISOString(),
      };
      await writer.commit(meta);
      return {
        status: "synced",
        rows: writer.count,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    } catch (err) {
      await writer.abort();
      throw err;
    }
  } finally {
    await rm(download, { force: true });
  }
}

/** Same resource, same last_modified, and the copy is less than a week old. */
export function isUnchanged(
  current: MirrorMeta,
  fingerprint: { id: string; url: string; last_modified?: string | null },
  now = Date.now(),
): boolean {
  const prev = current.resources[0];
  if (!prev || prev.id !== fingerprint.id || prev.url !== fingerprint.url) return false;
  if ((prev.last_modified ?? null) !== (fingerprint.last_modified ?? null)) return false;
  const age = now - Date.parse(current.synced_at);
  return Number.isFinite(age) && age >= 0 && age < MAX_UNCHANGED_AGE_MS;
}

export function pickMirrorResource(
  resources: CkanResource[],
  spec: MirrorSpec,
): CkanResource | undefined {
  if (!spec.resource) return pickBestResource(resources);
  const matching = resources.filter(
    (r) => r.state !== "deleted" && r.url && spec.resource!.test(`${r.name ?? ""} ${r.url}`.trim()),
  );
  // Several matches (re-uploads): take the newest.
  return matching.sort((a, b) =>
    (b.last_modified ?? b.created ?? "").localeCompare(a.last_modified ?? a.created ?? ""),
  )[0];
}

/** The sync runs as root-adjacent cron: it only ever talks to the portal. */
export function assertAllowedDownloadUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`download refused: invalid URL ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "data.gov.ua" && !host.endsWith(".gov.ua"))) {
    throw new Error(`download refused: ${parsed.protocol}//${host} is not a gov.ua HTTPS host`);
  }
  return parsed;
}

async function downloadToFile(
  url: string,
  path: string,
  userAgent: string,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let target = assertAllowedDownloadUrl(url);
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    const current = await fetch(target, {
      headers: { "user-agent": userAgent },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (current.status < 300 || current.status >= 400) {
      res = current;
      break;
    }
    const location = current.headers.get("location");
    await current.body?.cancel();
    if (!location) throw new Error(`download failed: HTTP ${current.status} without Location`);
    if (hop >= MAX_REDIRECTS) throw new Error(`download failed: more than ${MAX_REDIRECTS} redirects`);
    // Every hop is re-checked: a portal redirect to a CDN outside gov.ua is refused.
    target = assertAllowedDownloadUrl(new URL(location, target).href);
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(path));
}

async function openRows(
  path: string,
  spec: MirrorSpec,
  onDropped: (n: number) => void,
): Promise<AsyncGenerator<Row>> {
  const head = Buffer.alloc(2);
  const fh = createReadStream(path, { start: 0, end: 1 });
  for await (const chunk of fh as AsyncIterable<Buffer>) chunk.copy(head);

  let bytes: Readable;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const entries = await listZipEntries(path, (await stat(path)).size);
    const ext = spec.format === "xml" ? /\.xml$/i : /\.(csv|tsv|txt)$/i;
    // The data file is the largest matching entry (schemas/readmes ride along).
    const entry = entries.filter((e) => ext.test(e.name)).sort((a, b) => b.size - a.size)[0];
    if (!entry) {
      throw new Error(`no ${spec.format} file in ZIP: ${entries.map((e) => e.name).join(", ")}`);
    }
    bytes = await openZipEntry(path, entry);
  } else {
    bytes = createReadStream(path);
  }
  const text = decodeStream(bytes);
  return spec.format === "xml"
    ? xmlRows(text, spec.recordTag ?? "RECORD")
    : csvRows(text, { onDropped });
}

function renameColumns(row: Row, rename: Record<string, string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[rename[k] ?? k] = v;
  return out;
}

const MIRROR_FILE = /^[a-z0-9-]+\.(sqlite|sqlite\.tmp|download)$/;

/**
 * Delete databases of registries that are no longer mirrored. Touches only
 * files we would have written, and only in a directory we marked as ours.
 */
export async function pruneMirror(dir: string, keepKeys: string[], log: Logger): Promise<void> {
  let files: string[];
  try {
    await access(join(dir, SENTINEL));
    files = await readdir(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!MIRROR_FILE.test(f)) continue;
    const key = f.replace(/\.sqlite(\.tmp)?$|\.download$/, "");
    if (!keepKeys.includes(key)) {
      await rm(join(dir, f), { force: true });
      log.info("mirror pruned", { file: f });
    }
  }
}

export class MirrorLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another sync (pid ${pid}) holds the mirror lock`);
    this.name = "MirrorLockedError";
  }
}

const LOCK_FILE = ".sync.lock";

/**
 * One sync per directory: two writers would race on the same tmp files. The
 * lock names its PID so a lock left by a killed process is taken over.
 */
export async function lockMirror(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, LOCK_FILE);
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => rm(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw err;
    }
    const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (pid && pid !== process.pid && isAlive(pid)) throw new MirrorLockedError(pid);
    await rm(path, { force: true }); // stale: owner is gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}
