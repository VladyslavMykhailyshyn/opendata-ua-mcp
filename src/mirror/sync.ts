import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
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
import { MirrorReader, MirrorWriter, type MirrorMeta } from "./store.js";
import { listZipEntries, openZipEntry } from "./zip-stream.js";

export interface SyncOptions {
  dir: string;
  userAgent: string;
  force?: boolean;
  /** Print the first rows instead of building (to fix column config). */
  inspect?: boolean;
}

export type SyncOutcome =
  | { status: "synced"; rows: number; seconds: number }
  | { status: "unchanged" }
  | { status: "inspected"; sample: Row[] };

// Full registries are hundreds of MB; the portal can be slow.
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

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
  if (!opts.force && !opts.inspect) {
    const reader = new MirrorReader(opts.dir);
    const current = await reader.meta(def.key).catch(() => undefined);
    reader.close();
    const prev = current?.resources[0];
    if (prev && prev.id === fingerprint.id && prev.last_modified === fingerprint.last_modified) {
      return { status: "unchanged" };
    }
  }

  await mkdir(opts.dir, { recursive: true });
  const download = join(opts.dir, `${def.key}.download`);
  try {
    log.info("mirror download", { registry: def.key, resource: resource.id, url: resource.url });
    await downloadToFile(resource.url, download, opts.userAgent);
    const rows = await openRows(download, def.mirror);

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
      for await (const raw of rows) {
        const row = def.mirror.rename ? renameColumns(raw, def.mirror.rename) : raw;
        if (writer.count === 0) {
          const missing = writer.missingColumns(row);
          if (missing.length) {
            throw new Error(
              `columns ${missing.join(", ")} not in data; available: ${Object.keys(row).join(", ")}`,
            );
          }
        }
        writer.add(row);
        if (writer.count % 1_000_000 === 0) {
          log.info("mirror progress", { registry: def.key, rows: writer.count });
        }
      }
      if (writer.count === 0) throw new Error("no records parsed");
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

async function downloadToFile(url: string, path: string, userAgent: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent },
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(path));
}

async function openRows(path: string, spec: MirrorSpec): Promise<AsyncGenerator<Row>> {
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
  return spec.format === "xml" ? xmlRows(text, spec.recordTag ?? "RECORD") : csvRows(text);
}

function renameColumns(row: Row, rename: Record<string, string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[rename[k] ?? k] = v;
  return out;
}
