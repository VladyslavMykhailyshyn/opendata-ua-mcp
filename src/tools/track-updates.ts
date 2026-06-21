import { z } from "zod";
import { recentlyChanged } from "../ckan/actions.js";
import { datasetUrl, relativeAge } from "../util/humanize.js";
import { normalizeQuery } from "../util/unicode.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  topic: z.string().optional().describe("Фільтр за словом у назві датасету"),
  organization: z.string().optional().describe("Фільтр за назвою/slug розпорядника"),
  limit: z.number().int().min(1).max(50).default(15),
};

const schema = z.object(shape);

export const trackUpdates: ToolFactory = (ctx): ToolDef => ({
  name: "track_updates",
  description:
    "Стрічка нещодавно оновлених датасетів на data.gov.ua (моніторинг). Можна звузити за темою або розпорядником. Повертає компактний список: назва, розпорядник, коли змінено, тип зміни, посилання.",
  inputSchema: shape,
  handler: async (raw) => {
    const args = schema.parse(raw);
    // Over-fetch a bit so client-side filtering still returns ~limit items.
    const activities = await recentlyChanged(ctx.ckan, args.topic || args.organization ? args.limit * 5 : args.limit);

    const topic = args.topic ? normalizeQuery(args.topic).toLowerCase() : undefined;
    const org = args.organization?.toLowerCase();

    const changes = [];
    for (const a of activities) {
      const pkg = a.data?.package;
      if (!pkg?.name) continue;
      const title = pkg.title ?? pkg.name;
      const orgTitle = pkg.organization?.title ?? pkg.organization?.name;
      if (topic && !title.toLowerCase().includes(topic)) continue;
      if (org && !(orgTitle ?? "").toLowerCase().includes(org)) continue;
      changes.push({
        title,
        organization: orgTitle,
        changed_at: a.timestamp,
        when: relativeAge(a.timestamp),
        change_type: a.activity_type,
        dataset_url: datasetUrl(pkg.name),
      });
      if (changes.length >= args.limit) break;
    }

    return JSON.stringify({
      returned: changes.length,
      changes,
      source_url: "https://data.gov.ua/dataset?q=&sort=metadata_modified+desc",
    });
  },
});
