import { z } from "zod";
import { datastoreSearch, resourceShow } from "../ckan/actions.js";
import type { CkanClient } from "../ckan/client.js";
import type { CkanPackage, CkanResource } from "../ckan/types.js";
import { CkanNotFoundError } from "../ckan/errors.js";
import { normalizeFormat } from "../util/formats.js";
import { resolvePackage } from "../util/resolve.js";
import { pickBestResource } from "../util/resource-picker.js";
import { downloadCapped, decodeText, trimToLastLine } from "../util/download.js";
import {
  MAX_COLUMNS,
  parseCsv,
  parseJsonTable,
  parseXlsx,
  parseXmlTable,
  type ParsedTable,
} from "../util/csv.js";
import { ToolError } from "../util/errors.js";
import { officeContainerFormat, pickBestZipEntry } from "../util/zip.js";
import { humanSize } from "../util/humanize.js";
import { MIRRORED } from "../registries.js";
import { cleanFields, cleanRows } from "../util/datastore.js";
import type { ToolContext, ToolDef, ToolFactory } from "./types.js";

/** Longest cell value returned in a preview (files are publisher-controlled). */
const MAX_CELL_CHARS = 500;
/** Longest schema / column list returned. */
const MAX_SCHEMA_COLUMNS = 200;

/** Parse a buffer into a table given its (normalized) format. */
function parseByFormat(
  buffer: Buffer,
  fmt: string,
  limit: number,
  contentType?: string,
): ParsedTable {
  if (fmt === "XLSX" || fmt === "XLS" || fmt === "ODS") return parseXlsx(buffer, limit);
  const text = decodeText(buffer, contentType);
  if (fmt === "JSON" || fmt === "GEOJSON") return parseJsonTable(text, limit);
  if (fmt === "XML") return parseXmlTable(text, limit);
  return parseCsv(text, limit);
}

const shape = {
  dataset: z
    .string()
    .max(300)
    .optional()
    .describe("ID/slug/назва датасету (автовибір найкращого ресурсу)"),
  resource_id: z
    .string()
    .max(300)
    .optional()
    .describe("ID конкретного ресурсу (має пріоритет над dataset)"),
  columns: z.array(z.string().max(200)).max(100).optional().describe("Обмежити колонки"),
  limit: z.number().int().min(1).max(100).default(10).describe("Скільки рядків-прев'ю"),
};

const schema = z.object(shape);

async function resolveResource(
  ckan: CkanClient,
  args: z.infer<typeof schema>,
): Promise<{ resource: CkanResource; pkg?: CkanPackage }> {
  if (args.resource_id) return { resource: await resourceShow(ckan, args.resource_id) };
  if (!args.dataset) {
    throw new CkanNotFoundError("Вкажи dataset або resource_id");
  }
  const pkg = await resolvePackage(ckan, args.dataset);
  const best = pickBestResource(pkg.resources);
  if (!best) {
    throw new CkanNotFoundError(
      `У датасеті "${pkg.title ?? pkg.name}" немає машиночитного ресурсу (CSV/JSON/XLSX). Подивись inspect_dataset.`,
    );
  }
  return { resource: best, pkg };
}

export const getDatasetData: ToolFactory = (ctx): ToolDef => ({
  name: "get_dataset_data",
  description:
    "Отримати самі дані (перші рядки + схема колонок) з датасету чи ресурсу. Автоматично обирає найкращий машиночитний ресурс. Якщо є DataStore — читає звідти; інакше завантажує файл і парсить локально (CSV/JSON/XLSX). Повертає прев'ю (обмежене), оцінку кількості рядків і посилання на повний файл. Це твій основний інструмент для «покажи дані».",
  inputSchema: shape,
  handler: async (raw, call) => {
    const args = schema.parse(raw);
    const ckan = ctx.ckan.withSignal(call.signal);
    const { resource, pkg } = await resolveResource(ckan, args);
    const lookup = lookupHint(ctx, resource, pkg);
    const fmt = normalizeFormat(resource.format);
    const picked = { id: resource.id, name: resource.name, format: fmt };
    const fullData = { download_url: resource.url, size: humanSize(resource.size) };

    // Path 1: DataStore (rare, ~0.3% of resources) — query directly, no download.
    if (resource.datastore_active) {
      const ds = await datastoreSearch(ckan, {
        resource_id: resource.id,
        limit: args.limit,
        fields: args.columns,
      });
      return finish(
        {
          source: "datastore",
          picked_resource: picked,
          schema: cleanFields(ds.fields).slice(0, MAX_SCHEMA_COLUMNS),
          preview_rows: cleanRows(ds.records).map(truncateCells),
          row_count_estimate: ds.total,
          full_data: { download_url: resource.url, query_tool: "filter_data" },
        },
        ctx.config.maxResponseChars,
      );
    }

    // Path 2: download + parse locally.
    if (!resource.url) {
      throw new CkanNotFoundError(`Ресурс ${resource.id} не має URL для завантаження`);
    }
    const url = resource.url;
    const dl = await ctx.ckan.upstream.run(
      () =>
        downloadCapped(
          url,
          ctx.config.maxDownloadBytes,
          ctx.config.httpTimeoutMs,
          ctx.config.userAgent,
          call.signal,
        ),
      call.signal,
    );

    // Detect real container by magic bytes (files are often mislabeled).
    const magic = dl.buffer.subarray(0, 4);
    const hasZipMagic = magic[0] === 0x50 && magic[1] === 0x4b; // "PK"
    // XLSX/ODS are ZIP containers too — parse them as spreadsheets, not archives.
    const officeFmt = hasZipMagic ? officeContainerFormat(dl.buffer) : undefined;
    const isZip = hasZipMagic && !officeFmt;
    const isPdf = magic.toString("latin1", 0, 4) === "%PDF";

    if (isPdf) {
      return JSON.stringify({
        source: "file",
        picked_resource: picked,
        note: `Файл — PDF, табличний парсинг неможливий. Завантаж вручну.`,
        full_data: fullData,
      });
    }

    // ZIP (flagship registries like ЄДР / реєстр боржників ship zipped):
    // extract the best parseable inner file and parse that.
    let buffer = dl.buffer;
    let parseFmt = officeFmt ?? fmt;
    let extractedFrom: string | undefined;
    let skippedEntries = 0;
    if (officeFmt && dl.truncated) {
      // A spreadsheet's index sits at the end of the container; a prefix is unreadable.
      return JSON.stringify({
        source: "file",
        picked_resource: picked,
        note: withLookup(
          `Файл ${officeFmt} більший за ліміт завантаження (${humanSize(dl.bytes)}) — частково прочитати неможливо. Завантаж вручну.`,
          lookup,
        ),
        full_data: fullData,
      });
    }
    if (!hasZipMagic && dl.truncated) buffer = trimToLastLine(buffer);
    if (isZip) {
      if (dl.truncated) {
        return JSON.stringify({
          source: "zip",
          picked_resource: picked,
          note: withLookup(
            `ZIP-архів більший за ліміт завантаження (${humanSize(dl.bytes)}) — розпакувати частково неможливо. Завантаж вручну.`,
            lookup,
          ),
          full_data: fullData,
        });
      }
      let entries;
      try {
        entries = pickBestZipEntry(dl.buffer, ctx.config.maxDownloadBytes);
      } catch (err) {
        ctx.log.warn("zip open failed", { resource: resource.id, message: (err as Error).message });
        return JSON.stringify({
          source: "zip",
          picked_resource: picked,
          note:
            err instanceof ToolError
              ? `${err.message} Завантаж вручну.`
              : "Не вдалося відкрити ZIP-архів. Завантаж вручну.",
          full_data: fullData,
        });
      }
      const { best, names } = entries;
      skippedEntries = entries.skipped;
      if (!best) {
        return JSON.stringify({
          source: "zip",
          picked_resource: picked,
          note:
            skippedEntries > 0
              ? `Файли в ZIP-архіві більші за ліміт завантаження або зашифровані (${names.length} записів). Завантаж вручну.`
              : `ZIP-архів без машиночитного файлу всередині (${names.length} записів). Завантаж вручну.`,
          archive_contents: names,
          full_data: fullData,
        });
      }
      buffer = best.buffer;
      parseFmt = best.format;
      extractedFrom = best.name;
    }

    let table: ParsedTable;
    try {
      table = parseByFormat(buffer, parseFmt, args.limit, isZip ? undefined : dl.contentType);
    } catch (err) {
      // Unparseable (PDF/scan/binary) — return metadata + link instead of dumping bytes.
      ctx.log.warn("parse failed", {
        resource: resource.id,
        format: parseFmt,
        message: (err as Error).message,
      });
      return JSON.stringify({
        source: "file",
        picked_resource: picked,
        note:
          err instanceof ToolError
            ? `${err.message} Завантаж файл вручну.`
            : "Не вдалося розібрати файл як таблицю. Завантаж файл вручну.",
        full_data: fullData,
      });
    }

    let columns = table.columns;
    let rows = table.rows;
    if (args.columns?.length) {
      const keep = new Set(args.columns);
      columns = columns.filter((c) => keep.has(c.col));
      rows = rows.map((r) => Object.fromEntries(args.columns!.map((c) => [c, r[c]])));
    }
    const notes: string[] = [];
    if (columns.length > MAX_SCHEMA_COLUMNS) {
      columns = columns.slice(0, MAX_SCHEMA_COLUMNS);
      const keep = columns.map((c) => c.col);
      rows = rows.map((r) => Object.fromEntries(keep.map((c) => [c, r[c]])));
      notes.push(`У файлі ${table.columns.length} колонок — показано перші ${MAX_SCHEMA_COLUMNS}.`);
    } else if (table.droppedColumns) {
      notes.push(`У файлі понад ${MAX_COLUMNS} колонок — показано перші ${MAX_COLUMNS}.`);
    }
    rows = rows.map(truncateCells);

    if (extractedFrom) notes.push(`Видобуто «${extractedFrom}» з ZIP-архіву.`);
    if (skippedEntries > 0) {
      notes.push(`Пропущено ${skippedEntries} файл(ів) архіву: завеликі або зашифровані.`);
    }
    if (dl.truncated)
      notes.push(`Завантажено перші ${humanSize(dl.bytes)}; повний файл за посиланням.`);
    if (table.droppedRows) {
      notes.push(`Пропущено ${table.droppedRows} рядків із незакритими лапками або завеликих.`);
    }
    if (lookup) notes.push(lookup);

    const rowCountEstimate = dl.truncated
      ? `≥${table.rowCount} (файл обрізано за лімітом)`
      : table.rowCountIsLowerBound
        ? `≥${table.rowCount}`
        : table.rowCount;

    return finish(
      {
        source: isZip ? "zip" : "file",
        picked_resource: {
          ...picked,
          ...(extractedFrom ? { extracted_from: extractedFrom, inner_format: parseFmt } : {}),
        },
        schema: columns,
        preview_rows: rows,
        row_count_estimate: rowCountEstimate,
        full_data: fullData,
        ...(notes.length ? { note: notes.join(" ") } : {}),
      },
      ctx.config.maxResponseChars,
    );
  },
});

function truncateCells(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(row)) {
    const s = typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : null;
    if (s !== null && s.length > MAX_CELL_CHARS) {
      out ??= { ...row };
      out[k] = `${s.slice(0, MAX_CELL_CHARS)}…`;
    }
  }
  return out ?? row;
}

interface DataPayload {
  preview_rows: Record<string, unknown>[];
  note?: string;
  [key: string]: unknown;
}

/** Serialize; drop trailing preview rows until the JSON fits the response budget. */
function finish(payload: DataPayload, maxChars: number): string {
  let json = JSON.stringify(payload);
  if (json.length <= maxChars) return json;
  const rows = [...payload.preview_rows];
  const total = rows.length;
  do {
    rows.pop();
    json = JSON.stringify({
      ...payload,
      preview_rows: rows,
      note: `${payload.note ? `${payload.note} ` : ""}Прев'ю скорочено до ${rows.length} із ${total} рядків, щоб вкластися в ліміт відповіді.`,
    });
  } while (rows.length > 0 && json.length > maxChars);
  return json;
}

/** Full-file search beats a preview for registries mirrored on this server. */
function lookupHint(
  ctx: ToolContext,
  resource: CkanResource,
  pkg: CkanPackage | undefined,
): string | undefined {
  if (!ctx.config.mirrorDir || !pkg) return undefined;
  const url = resource.url ?? "";
  const def = MIRRORED.find(
    (r) =>
      (r.dataset === pkg.name || r.dataset === pkg.id) &&
      (!r.mirror.resource || r.mirror.resource.test(url)),
  );
  return def
    ? `Щоб знайти конкретний запис у всьому реєстрі, використай lookup_record (registry: "${def.key}").`
    : undefined;
}

function withLookup(note: string, lookup: string | undefined): string {
  return lookup ? `${note} ${lookup}` : note;
}
