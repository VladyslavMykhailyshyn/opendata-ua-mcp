import { z } from "zod";
import { packageSearch } from "../ckan/actions.js";
import type { CkanFacet } from "../ckan/types.js";
import { buildFq, buildSort, type SortKey } from "../ckan/solr.js";
import { normalizeFormat } from "../util/formats.js";
import { normalizeQuery } from "../util/unicode.js";
import { capPayload, makeEnvelope } from "../util/envelope.js";
import { toDatasetHit } from "../util/project.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  query: z.string().optional().describe("Тема або ключові слова (напр. «закупівлі громади 2024»)"),
  category: z.string().optional().describe("Slug тематичної категорії (напр. 'ekolohiia')"),
  organization: z.string().optional().describe("Slug розпорядника"),
  format: z.string().optional().describe("Формат файлу: CSV, JSON, XLSX, …"),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(5),
  offset: z.number().int().min(0).default(0),
  sort: z
    .enum(["relevance", "modified_desc", "views_desc", "created_desc"])
    .default("relevance"),
};

const schema = z.object(shape);

function refineHints(facets: Record<string, CkanFacet> | undefined) {
  if (!facets) return undefined;
  const pick = (key: string) =>
    (facets[key]?.items ?? [])
      .slice(0, 5)
      .map((i) => ({ value: i.name, label: i.display_name ?? i.name, count: i.count }));
  return {
    organizations: pick("organization"),
    categories: pick("groups"),
    formats: pick("res_format"),
  };
}

export const findDatasets: ToolFactory = (ctx): ToolDef => ({
  name: "find_datasets",
  description:
    "Знайти датасети на data.gov.ua за темою. Повертає компактний ранжований список кандидатів (назва, розпорядник, формати, свіжість, посилання) + підказки для звуження пошуку (топ розпорядники/категорії/формати). Використовуй це для будь-якого «знайди дані про …».",
  inputSchema: shape,
  handler: async (raw) => {
    const args = schema.parse(raw);
    const q = args.query ? normalizeQuery(args.query) : undefined;
    const fq = buildFq({
      organization: args.organization,
      category: args.category,
      format: args.format ? normalizeFormat(args.format) : undefined,
      tags: args.tags,
    });
    const result = await packageSearch(ctx.ckan, {
      q,
      fq,
      rows: args.limit,
      start: args.offset,
      sort: buildSort(args.sort as SortKey),
      facetFields: ["organization", "groups", "res_format"],
      facetLimit: 5,
    });

    const env = makeEnvelope({
      count: result.count,
      results: result.results.map(toDatasetHit),
      offset: args.offset,
      sourceUrl: "https://data.gov.ua/dataset",
    });
    const payload = {
      ...env,
      refine_hints: refineHints(result.search_facets),
    };
    return capPayload(payload as typeof env, ctx.config);
  },
});
