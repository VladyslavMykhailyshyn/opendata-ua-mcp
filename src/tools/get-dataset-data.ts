import { z } from "zod";
import { datastoreSearch, resourceShow } from "../ckan/actions.js";
import type { CkanResource } from "../ckan/types.js";
import { CkanNotFoundError } from "../ckan/errors.js";
import { normalizeFormat } from "../util/formats.js";
import { resolvePackage } from "../util/resolve.js";
import { pickBestResource } from "../util/resource-picker.js";
import { downloadCapped, decodeText } from "../util/download.js";
import { parseCsv, parseJsonTable, parseXlsx, type ParsedTable } from "../util/csv.js";
import { humanSize } from "../util/humanize.js";
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
): Promise<CkanResource> {
  if (args.resource_id) return resourceShow(ctx.ckan, args.resource_id);
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
  return best;
}

export const getDatasetData: ToolFactory = (ctx): ToolDef => ({
  name: "get_dataset_data",
  description:
    "Отримати самі дані (перші рядки + схема колонок) з датасету чи ресурсу. Автоматично обирає найкращий машиночитний ресурс. Якщо є DataStore — читає звідти; інакше завантажує файл і парсить локально (CSV/JSON/XLSX). Повертає прев'ю (обмежене), оцінку кількості рядків і посилання на повний файл. Це твій основний інструмент для «покажи дані».",
  inputSchema: shape,
  handler: async (raw) => {
    const args = schema.parse(raw);
    const resource = await resolveResource(ctx, args);
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
    const isBinary = fmt === "XLSX" || fmt === "XLS";
    const dl = await downloadCapped(
      resource.url,
      ctx.config.maxDownloadBytes,
      ctx.config.httpTimeoutMs,
      ctx.config.userAgent,
    );

    // Guard against files mislabeled as text (ZIP/PDF served as .csv/.json).
    const magic = dl.buffer.subarray(0, 4);
    const isZip = magic[0] === 0x50 && magic[1] === 0x4b; // "PK"
    const isPdf = magic.toString("latin1", 0, 4) === "%PDF";
    if (!isBinary && (isZip || isPdf)) {
      return JSON.stringify({
        source: "file",
        picked_resource: { id: resource.id, name: resource.name, format: fmt },
        note: `Файл насправді ${isZip ? "ZIP-архів" : "PDF"}, попри формат «${fmt}». Завантаж вручну.`,
        full_data: { download_url: resource.url, size: humanSize(resource.size) },
      });
    }

    let table: ParsedTable;
    try {
      if (isBinary) {
        table = parseXlsx(dl.buffer, args.limit);
      } else {
        const text = decodeText(dl.buffer, dl.contentType);
        table =
          fmt === "JSON" || fmt === "GEOJSON"
            ? parseJsonTable(text, args.limit)
            : parseCsv(text, args.limit);
      }
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

    return JSON.stringify({
      source: "file",
      picked_resource: { id: resource.id, name: resource.name, format: fmt },
      schema: columns,
      preview_rows: rows,
      row_count_estimate: dl.truncated ? `≥${table.rowCount} (файл обрізано за лімітом)` : table.rowCount,
      full_data: { download_url: resource.url, size: humanSize(resource.size) },
      ...(dl.truncated
        ? { note: `Завантажено перші ${humanSize(dl.bytes)}; повний файл за посиланням.` }
        : {}),
    });
  },
});
