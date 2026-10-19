import { z } from "zod";
import { MIRRORED } from "../registries.js";
import { MirrorReader } from "../mirror/store.js";
import { datasetUrl } from "../util/humanize.js";
import { capPayload, makeEnvelope } from "../util/envelope.js";
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

/**
 * Lookup over full local copies of flagship registries (synced daily by
 * dist/sync.js). Registered only when MIRROR_DIR is configured.
 */
export const lookupRecord: ToolFactory = (ctx): ToolDef => {
  const reader = new MirrorReader(ctx.config.mirrorDir!);
  return {
    name: "lookup_record",
    description:
      "Знайти конкретний запис у повному реєстрі: компанію за ЄДРПОУ чи назвою, ФОП за ПІБ, авто за VIN, платника ПДВ, боржника, справу про банкрутство чи судове засідання. Шукає по всьому файлу (сотні МБ, які get_dataset_data не завантажує), з локальної копії, що оновлюється щодня. Код → точний збіг; слова → усі мають збігтися (за початком слова).",
    inputSchema: shape,
    handler: async (raw) => {
      const args = schema.parse(raw);
      const def = MIRRORED.find((r) => r.key === args.registry)!;
      const found = await reader.lookup(def.key, args.query, args.limit);
      const meta = await reader.meta(def.key);
      if (!found || !meta) {
        return JSON.stringify({
          error: `Реєстр «${def.title}» ще не синхронізовано на цьому сервері.`,
          dataset_url: datasetUrl(def.dataset),
        });
      }
      const rows = found.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) + "…" : v,
          ]),
        ),
      );
      const env = makeEnvelope({
        count: rows.length + (found.more ? 1 : 0),
        results: rows,
        offset: 0,
        sourceUrl: datasetUrl(meta.dataset),
        note: found.more ? "Є ще збіги — уточни запит (повніша назва, код)." : undefined,
      });
      return capPayload(
        {
          ...env,
          registry: def.title,
          match: found.match,
          snapshot: {
            synced_at: meta.synced_at,
            source_updated: meta.resources[0]?.last_modified ?? undefined,
            rows_in_registry: meta.row_count,
          },
        } as typeof env,
        ctx.config,
      );
    },
  };
};
