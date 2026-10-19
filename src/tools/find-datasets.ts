import { z } from "zod";
import { packageSearch, packageShow } from "../ckan/actions.js";
import type { CkanFacet } from "../ckan/types.js";
import { buildFq, buildSort, type SortKey } from "../ckan/solr.js";
import { normalizeFormat } from "../util/formats.js";
import { normalizeQuery } from "../util/unicode.js";
import { capPayload, makeEnvelope } from "../util/envelope.js";
import { toDatasetHit, type DatasetHit } from "../util/project.js";
import { relaxQuery, wrongDoors } from "../util/query-intent.js";
import { registriesForQuery, type RegistryDef } from "../registries.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  query: z.string().optional().describe("Тема або ключові слова (напр. «закупівлі громади 2024»)"),
  category: z.string().optional().describe("Slug тематичної категорії (напр. 'ekolohiia')"),
  organization: z.string().optional().describe("Slug розпорядника"),
  format: z.string().optional().describe("Формат файлу: CSV, JSON, XLSX, …"),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(5),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(["relevance", "modified_desc", "views_desc", "created_desc"]).default("relevance"),
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
    const search = (query: string | undefined) =>
      packageSearch(ctx.ckan, {
        q: query,
        fq,
        rows: args.limit,
        start: args.offset,
        sort: buildSort(args.sort as SortKey),
        facetFields: ["organization", "groups", "res_format"],
        facetLimit: 5,
      });

    let result = await search(q);
    // Portal search needs every word in its exact form, so natural phrasing
    // often finds nothing; retry with stemmed AND, then stemmed OR.
    let relaxed: string | undefined;
    for (const attempt of result.count === 0 && q ? relaxQuery(q) : []) {
      result = await search(attempt);
      if (result.count > 0) {
        relaxed = attempt;
        break;
      }
    }

    // Registries asked for by name go first: search ranks short names
    // ("ЄДР", "реєстр ФОП") below unrelated "Єдиний державний реєстр …".
    const registries = q && args.offset === 0 ? registriesForQuery(q) : [];
    const pinned = await pinRegistries(registries);
    const pinnedIds = new Set(pinned.map((h) => h.id));
    const hits = [
      ...pinned,
      ...result.results.map(toDatasetHit).filter((h) => !pinnedIds.has(h.id)),
    ];

    const env = makeEnvelope({
      count: Math.max(result.count, hits.length),
      results: hits,
      offset: args.offset,
      sourceUrl: "https://data.gov.ua/dataset",
      note: relaxed
        ? `Точний збіг не знайдено; показано результати розширеного пошуку (${relaxed}).`
        : undefined,
    });
    const lookups = ctx.config.mirrorDir
      ? registries.filter((r) => r.mirror).map((r) => ({ registry: r.key, for: r.lookupHint }))
      : [];
    const elsewhere = q ? wrongDoors(q) : [];
    const payload = {
      ...env,
      ...(lookups.length ? { lookup_record: lookups } : {}),
      ...(elsewhere.length ? { elsewhere } : {}),
      refine_hints: refineHints(result.search_facets),
    };
    return capPayload(payload as typeof env, ctx.config);

    async function pinRegistries(defs: RegistryDef[]): Promise<DatasetHit[]> {
      const datasets = [...new Set(defs.map((r) => r.dataset))].slice(0, 2);
      const out: DatasetHit[] = [];
      for (const id of datasets) {
        try {
          out.push({ ...toDatasetHit(await packageShow(ctx.ckan, id)), match: "registry" });
        } catch (err) {
          // A moved/renamed registry must not break search itself.
          ctx.log.warn("registry pin failed", { dataset: id, message: (err as Error).message });
        }
      }
      return out;
    }
  },
});
