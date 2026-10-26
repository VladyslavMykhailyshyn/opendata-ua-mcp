import { z } from "zod";
import { datastoreSearch, datastoreSearchSql } from "../ckan/actions.js";
import { CkanValidationError } from "../ckan/errors.js";
import { cleanFields, cleanRows } from "../util/datastore.js";
import { capPayload, makeEnvelope } from "../util/envelope.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  resource_id: z.string().max(300).describe("ID ресурсу (має бути DataStore-активним)"),
  filters: z
    .record(z.string().max(200), z.union([z.string().max(300), z.number()]))
    .optional()
    .describe('Точні фільтри колонка=значення, напр. {"region":"Київ","year":2024}'),
  q: z.string().max(300).optional().describe("Повнотекстовий пошук по рядках"),
  sql: z
    .string()
    .max(4000)
    .optional()
    .describe("Read-only SQL замість filters (тільки SELECT). Має пріоритет."),
  fields: z.array(z.string().max(200)).max(100).optional().describe("Колонки на вихід"),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10_000).default(0),
};

const schema = z.object(shape);

// Block any DML/DDL — datastore_search_sql is read-only but we defend anyway.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i;

// DataStore cells can hold whole documents; the client asked for rows, not blobs.
const MAX_CELL_CHARS = 500;

function assertReadOnlySql(sql: string): void {
  if (/;/.test(sql.trim().replace(/;$/, ""))) {
    throw new CkanValidationError("SQL: заборонено кілька стейтментів (;)");
  }
  if (FORBIDDEN.test(sql)) {
    throw new CkanValidationError("SQL: дозволені лише read-only SELECT-запити");
  }
  if (!/^\s*(select|with)\b/i.test(sql)) {
    throw new CkanValidationError("SQL: має починатися з SELECT/WITH");
  }
}

function trimCells(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        typeof v === "string" && v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + "…" : v,
      ]),
    ),
  );
}

export const filterData: ToolFactory = (ctx): ToolDef => ({
  name: "filter_data",
  description:
    "Фільтрувати/агрегувати рядки структурованого ресурсу: точні фільтри (колонка=значення) або read-only SQL (SELECT). Працює ЛИШЕ для DataStore-активних ресурсів (≈0.3% на порталі — перевір has_datastore через inspect_dataset). Для решти спершу візьми дані через get_dataset_data.",
  inputSchema: shape,
  handler: async (raw, call) => {
    const args = schema.parse(raw);
    if (args.sql) assertReadOnlySql(args.sql);
    const ckan = ctx.ckan.withSignal(call.signal);
    const downloadUrl = `https://data.gov.ua/dataset/resource/${encodeURIComponent(args.resource_id)}`;

    if (args.sql) {
      const ds = await datastoreSearchSql(ckan, args.sql);
      const rows = trimCells(cleanRows(ds.records));
      const env = makeEnvelope({
        count: rows.length,
        results: rows,
        offset: 0,
        sourceUrl: downloadUrl,
      });
      return capPayload(
        { ...env, source: "datastore_sql", schema: cleanFields(ds.fields) } as typeof env,
        ctx.config,
        "Narrow the SQL (WHERE/LIMIT) or use source_url for the rest.",
      );
    }

    const ds = await datastoreSearch(ckan, {
      resource_id: args.resource_id,
      q: args.q,
      filters: args.filters,
      fields: args.fields,
      limit: args.limit,
      offset: args.offset,
    });
    const rows = trimCells(cleanRows(ds.records));
    const env = makeEnvelope({
      count: ds.total,
      results: rows,
      offset: args.offset,
      sourceUrl: downloadUrl,
    });
    return capPayload(
      {
        ...env,
        source: "datastore",
        schema: cleanFields(ds.fields),
        full_data: { download_url: downloadUrl },
      } as typeof env,
      ctx.config,
    );
  },
});
