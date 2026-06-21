import { z } from "zod";
import { datastoreSearch, datastoreSearchSql } from "../ckan/actions.js";
import { CkanValidationError } from "../ckan/errors.js";
import { cleanFields, cleanRows } from "../util/datastore.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  resource_id: z.string().describe("ID ресурсу (має бути DataStore-активним)"),
  filters: z
    .record(z.union([z.string(), z.number()]))
    .optional()
    .describe("Точні фільтри колонка=значення, напр. {\"region\":\"Київ\",\"year\":2024}"),
  q: z.string().optional().describe("Повнотекстовий пошук по рядках"),
  sql: z
    .string()
    .optional()
    .describe("Read-only SQL замість filters (тільки SELECT). Має пріоритет."),
  fields: z.array(z.string()).optional().describe("Колонки на вихід"),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
};

const schema = z.object(shape);

// Block any DML/DDL — datastore_search_sql is read-only but we defend anyway.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i;

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

export const filterData: ToolFactory = (ctx): ToolDef => ({
  name: "filter_data",
  description:
    "Фільтрувати/агрегувати рядки структурованого ресурсу: точні фільтри (колонка=значення) або read-only SQL (SELECT). Працює ЛИШЕ для DataStore-активних ресурсів (≈0.3% на порталі — перевір has_datastore через inspect_dataset). Для решти спершу візьми дані через get_dataset_data.",
  inputSchema: shape,
  handler: async (raw) => {
    const args = schema.parse(raw);

    if (args.sql) {
      assertReadOnlySql(args.sql);
      const ds = await datastoreSearchSql(ctx.ckan, args.sql);
      return JSON.stringify({
        source: "datastore_sql",
        returned: ds.records.length,
        schema: cleanFields(ds.fields),
        rows: cleanRows(ds.records),
      });
    }

    const ds = await datastoreSearch(ctx.ckan, {
      resource_id: args.resource_id,
      q: args.q,
      filters: args.filters,
      fields: args.fields,
      limit: args.limit,
      offset: args.offset,
    });
    const returned = ds.records.length;
    const more = args.offset + returned < ds.total;
    return JSON.stringify({
      source: "datastore",
      count: ds.total,
      returned,
      more,
      ...(more ? { next_offset: args.offset + returned } : {}),
      schema: cleanFields(ds.fields),
      rows: cleanRows(ds.records),
      full_data: { download_url: `https://data.gov.ua/dataset/resource/${args.resource_id}` },
    });
  },
});
