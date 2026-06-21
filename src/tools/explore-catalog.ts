import { z } from "zod";
import { groupList, packageSearch } from "../ckan/actions.js";
import { buildFq } from "../ckan/solr.js";
import { normalizeFormat } from "../util/formats.js";
import { normalizeQuery } from "../util/unicode.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  query: z.string().optional().describe("Звузити до теми перед агрегуванням"),
  group_by: z
    .enum(["organization", "category", "format"])
    .default("organization")
    .describe("За чим рахувати: розпорядник / категорія / формат"),
  category: z.string().optional().describe("Slug категорії-фільтра"),
  organization: z.string().optional().describe("Slug розпорядника-фільтра"),
  limit: z.number().int().min(1).max(50).default(15),
};

const schema = z.object(shape);

const FACET_FIELD: Record<string, string> = {
  organization: "organization",
  category: "groups",
  format: "res_format",
};

// Slug≠title semantic-drift warnings (docs/3.8 §F): filtering by these slugs is misleading.
const DRIFT_NOTE =
  "Увага: деякі slug категорій не збігаються зі значенням (podatky=«доходи і видатки», ekolohiia=«навколишнє середовище», sotsialnyi-zakhyst=«суспільство»). Фільтруй обережно.";

export const exploreCatalog: ToolFactory = (ctx): ToolDef => ({
  name: "explore_catalog",
  description:
    "Огляд каталогу data.gov.ua агрегатами (без видачі самих датасетів): скільки всього, хто публікує найбільше, розподіл за категоріями/форматами. Дешево за токенами. Використовуй для «хто публікує найбільше даних про X», «скільки датасетів про Y».",
  inputSchema: shape,
  handler: async (raw) => {
    const args = schema.parse(raw);
    const field = FACET_FIELD[args.group_by]!;
    const fq = buildFq({
      organization: args.organization,
      category: args.category,
    });
    const result = await packageSearch(ctx.ckan, {
      q: args.query ? normalizeQuery(args.query) : undefined,
      fq,
      rows: 0,
      facetFields: [field],
      facetLimit: args.limit,
    });

    let labels: Record<string, string> = {};
    if (args.group_by === "category") {
      const groups = await groupList(ctx.ckan);
      labels = Object.fromEntries(groups.map((g) => [g.name, g.title ?? g.display_name ?? g.name]));
    }

    const items = result.search_facets?.[field]?.items ?? [];
    let breakdown: { key: string; label: string; count: number }[];
    if (args.group_by === "format") {
      // Merge dirty variants (xlsx/xlxs/XLSX) into one normalized bucket.
      const merged = new Map<string, number>();
      for (const i of items) {
        const key = normalizeFormat(i.name) || "(не вказано)";
        merged.set(key, (merged.get(key) ?? 0) + i.count);
      }
      breakdown = [...merged.entries()]
        .map(([key, count]) => ({ key, label: key, count }))
        .sort((a, b) => b.count - a.count);
    } else {
      breakdown = items.map((i) => ({
        key: i.name,
        label: labels[i.name] ?? i.display_name ?? i.name,
        count: i.count,
      }));
    }

    return JSON.stringify({
      total: result.count,
      group_by: args.group_by,
      breakdown,
      source_url: "https://data.gov.ua/dataset",
      ...(args.group_by === "category" ? { note: DRIFT_NOTE } : {}),
    });
  },
});
