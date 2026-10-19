import { z } from "zod";
import { datastoreSearch, resourceShow } from "../ckan/actions.js";
import type { CkanPackage, CkanResource } from "../ckan/types.js";
import { CkanNotFoundError } from "../ckan/errors.js";
import { normalizeFormat } from "../util/formats.js";
import { resolvePackage } from "../util/resolve.js";
import { pickBestResource } from "../util/resource-picker.js";
import { downloadCapped, decodeText, trimToLastLine } from "../util/download.js";
import {
  parseCsv,
  parseJsonTable,
  parseXlsx,
  parseXmlTable,
  type ParsedTable,
} from "../util/csv.js";
import { officeContainerFormat, pickBestZipEntry } from "../util/zip.js";
import { humanSize } from "../util/humanize.js";
import { MIRRORED } from "../registries.js";

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
import { cleanFields, cleanRows } from "../util/datastore.js";
import type { ToolContext, ToolDef, ToolFactory } from "./types.js";

const shape = {
  dataset: z.string().optional().describe("ID/slug/назва датасету (автовибір найкращого ресурсу)"),
  resource_id: z.string().optional().describe("ID конкретного ресурсу (має пріоритет над dataset)"),
  columns: z.array(z.string()).optional().describe("Обмежити колонки"),
  limit: z.number().int().min(1).max(100).default(10).describe("Скільки рядків-прев'ю"),
};

const schema = z.object(shape);

async function resolveResource(
  ctx: ToolContext,
  args: z.infer<typeof schema>,
): Promise<{ resource: CkanResource; pkg?: CkanPackage }> {
  if (args.resource_id) return { resource: await resourceShow(ctx.ckan, args.resource_id) };
  if (!args.dataset) {
    throw new CkanNotFoundError("Вкажи dataset або resource_id");
  }
  const pkg = await resolvePackage(ctx.ckan, args.dataset);
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
  handler: async (raw) => {
    const args = schema.parse(raw);
    const { resource, pkg } = await resolveResource(ctx, args);
    const lookup = lookupHint(ctx, resource, pkg);
    const fmt = normalizeFormat(resource.format);

    // Path 1: DataStore (rare, ~0.3% of resources) — query directly, no download.
    if (resource.datastore_active) {
      const ds = await datastoreSearch(ctx.ckan, {
        resource_id: resource.id,
        limit: args.limit,
        fields: args.columns,
      });
      return JSON.stringify({
        source: "datastore",
        picked_resource: { id: resource.id, name: resource.name, format: fmt },
        schema: cleanFields(ds.fields),
        preview_rows: cleanRows(ds.records),
        row_count_estimate: ds.total,
        full_data: { download_url: resource.url, query_tool: "filter_data" },
      });
    }

    // Path 2: download + parse locally.
    if (!resource.url) {
      throw new CkanNotFoundError(`Ресурс ${resource.id} не має URL для завантаження`);
    }
    const dl = await downloadCapped(
      resource.url,
      ctx.config.maxDownloadBytes,
      ctx.config.httpTimeoutMs,
      ctx.config.userAgent,
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
        picked_resource: { id: resource.id, name: resource.name, format: fmt },
        note: `Файл — PDF, табличний парсинг неможливий. Завантаж вручну.`,
        full_data: { download_url: resource.url, size: humanSize(resource.size) },
      });
    }

    // ZIP (flagship registries like ЄДР / реєстр боржників ship zipped):
    // extract the best parseable inner file and parse that.
    let buffer = dl.buffer;
    let parseFmt = officeFmt ?? fmt;
    let extractedFrom: string | undefined;
    if (officeFmt && dl.truncated) {
      // A spreadsheet's index sits at the end of the container; a prefix is unreadable.
      return JSON.stringify({
        source: "file",
        picked_resource: { id: resource.id, name: resource.name, format: fmt },
        note: withLookup(
          `Файл ${officeFmt} більший за ліміт завантаження (${humanSize(dl.bytes)}) — частково прочитати неможливо. Завантаж вручну.`,
          lookup,
        ),
        full_data: { download_url: resource.url, size: humanSize(resource.size) },
      });
    }
    if (!hasZipMagic && dl.truncated) buffer = trimToLastLine(buffer);
    if (isZip) {
      if (dl.truncated) {
        return JSON.stringify({
          source: "zip",
          picked_resource: { id: resource.id, name: resource.name, format: fmt },
          note: withLookup(
            `ZIP-архів більший за ліміт завантаження (${humanSize(dl.bytes)}) — розпакувати частково неможливо. Завантаж вручну.`,
            lookup,
          ),
          full_data: { download_url: resource.url, size: humanSize(resource.size) },
        });
      }
      let picked;
      try {
        picked = pickBestZipEntry(dl.buffer);
      } catch (err) {
        return JSON.stringify({
          source: "zip",
          picked_resource: { id: resource.id, name: resource.name, format: fmt },
          note: `Не вдалося відкрити ZIP-архів (${(err as Error).message}). Завантаж вручну.`,
          full_data: { download_url: resource.url, size: humanSize(resource.size) },
        });
      }
      const { best, names } = picked;
      if (!best) {
        return JSON.stringify({
          source: "zip",
          picked_resource: { id: resource.id, name: resource.name, format: fmt },
          note: `ZIP-архів без машиночитного файлу всередині (${names.length} записів). Завантаж вручну.`,
          archive_contents: names.slice(0, 20),
          full_data: { download_url: resource.url, size: humanSize(resource.size) },
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
      return JSON.stringify({
        source: "file",
        picked_resource: { id: resource.id, name: resource.name, format: fmt },
        note: `Не вдалося розпарсити як таблицю (${(err as Error).message}). Завантаж файл вручну.`,
        full_data: { download_url: resource.url, size: humanSize(resource.size) },
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
    if (extractedFrom) notes.push(`Видобуто «${extractedFrom}» з ZIP-архіву.`);
    if (dl.truncated)
      notes.push(`Завантажено перші ${humanSize(dl.bytes)}; повний файл за посиланням.`);
    if (lookup) notes.push(lookup);

    return JSON.stringify({
      source: isZip ? "zip" : "file",
      picked_resource: {
        id: resource.id,
        name: resource.name,
        format: fmt,
        ...(extractedFrom ? { extracted_from: extractedFrom, inner_format: parseFmt } : {}),
      },
      schema: columns,
      preview_rows: rows,
      row_count_estimate: dl.truncated
        ? `≥${table.rowCount} (файл обрізано за лімітом)`
        : table.rowCount,
      full_data: { download_url: resource.url, size: humanSize(resource.size) },
      ...(notes.length ? { note: notes.join(" ") } : {}),
    });
  },
});

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
