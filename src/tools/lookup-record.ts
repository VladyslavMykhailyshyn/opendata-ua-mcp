import { z } from "zod";
import { MIRRORED } from "../registries.js";
import { ftsQuery, isCodeQuery } from "../mirror/store.js";
import type { Row } from "../mirror/records.js";
import { datasetUrl } from "../util/humanize.js";
import type { Envelope } from "../util/envelope.js";
import { ToolError } from "../util/errors.js";
import type { ToolDef, ToolFactory } from "./types.js";

const KEYS = MIRRORED.map((r) => r.key) as [string, ...string[]];

const shape = {
  registry: z
    .enum(KEYS)
    .describe("Який реєстр: " + MIRRORED.map((r) => `${r.key} — ${r.lookupHint}`).join("; ")),
  query: z
    .string()
    .min(2)
    .max(200)
    .describe(
      "Код (ЄДРПОУ, ІПН, VIN, номер справи) для точного пошуку або назва/ПІБ для повнотекстового",
    ),
  limit: z.number().int().min(1).max(50).default(10),
};

const schema = z.object(shape);

// Some fields (court case descriptions, founders) run to kilobytes.
const MAX_FIELD_CHARS = 500;
// node:sqlite is synchronous: a query this slow stalled every other client.
const SLOW_LOOKUP_MS = 1000;

const NARROW = "уточни запит (повніша назва, код).";

type LookupEnvelope = Envelope<Row> & {
  registry: string;
  match: "exact" | "text";
  snapshot: { synced_at: string; source_updated?: string; rows_in_registry: number };
};

/**
 * Lookup over full local copies of flagship registries (synced daily by
 * dist/sync.js). Registered only when MIRROR_DIR is configured.
 */
export const lookupRecord: ToolFactory = (ctx): ToolDef => {
  // One reader per process (ServerDeps.mirror); never open handles per call.
  const reader = ctx.mirror!;
  return {
    name: "lookup_record",
    description:
      "Знайти конкретний запис у повному реєстрі: компанію за ЄДРПОУ чи назвою, ФОП за ПІБ, авто за VIN, платника ПДВ, боржника, справу про банкрутство чи судове засідання. Шукає по всьому файлу (сотні МБ, які get_dataset_data не завантажує), з локальної копії, що оновлюється щодня. Код → точний збіг; слова → усі мають збігтися (за початком слова, від 3 символів).",
    inputSchema: shape,
    handler: async (raw, call) => {
      const args = schema.parse(raw);
      const def = MIRRORED.find((r) => r.key === args.registry)!;
      // Nothing to anchor the index scan on: refuse rather than walk the table.
      if (!isCodeQuery(args.query) && !ftsQuery(args.query)) {
        throw new ToolError(
          "Запит занадто короткий: потрібне хоча б одне слово від 3 символів або код.",
        );
      }
      // The query itself can't be interrupted; at least don't start one for a
      // caller that has already gone.
      call.signal.throwIfAborted();
      const found = await reader.lookup(def.key, args.query, args.limit);
      const meta = await reader.meta(def.key);
      if (!found || !meta) {
        return JSON.stringify({
          error: `Реєстр «${def.title}» ще не синхронізовано на цьому сервері.`,
          dataset_url: datasetUrl(def.dataset),
        });
      }
      // Never the query text: it is a person's name more often than not.
      if (found.ms > SLOW_LOOKUP_MS) {
        ctx.log.warn("slow lookup", { registry: def.key, match: found.match, ms: found.ms });
      }
      const results = found.rows.map(trimFields);
      // No offset argument exists, so `count` is what was returned and `more`
      // says a narrower query would show the rest; never a next_offset.
      const env: LookupEnvelope = {
        count: results.length,
        returned: results.length,
        results,
        more: found.more,
        source_url: datasetUrl(meta.dataset),
        ...(found.more ? { note: `Є ще збіги — ${NARROW}` } : {}),
        registry: def.title,
        match: found.match,
        snapshot: {
          synced_at: meta.synced_at,
          source_updated: meta.resources[0]?.last_modified ?? undefined,
          rows_in_registry: meta.row_count,
        },
      };
      return capLookup(env, ctx.config.maxResponseChars);
    },
  };
};

/** Stored values are strings, but tolerate anything an older mirror file holds. */
function trimFields(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "string" && v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) + "…" : v,
    ]),
  );
}

/** Drop trailing rows until the payload fits; the hint is to narrow, not page. */
function capLookup(env: LookupEnvelope, maxChars: number): string {
  let json = JSON.stringify(env);
  if (json.length <= maxChars) return json;
  const capped = { ...env, results: [...env.results] };
  while (capped.results.length > 1 && JSON.stringify(capped).length > maxChars) {
    capped.results.pop();
  }
  capped.count = capped.returned = capped.results.length;
  capped.more = true;
  capped.note = `Відповідь скорочено до ${capped.returned} з ${env.returned} записів — ${NARROW}`;
  json = JSON.stringify(capped);
  return json;
}
