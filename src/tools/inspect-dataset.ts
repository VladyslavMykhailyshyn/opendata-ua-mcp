import { z } from "zod";
import { toDatasetCard } from "../util/project.js";
import { capPayload } from "../util/envelope.js";
import { resolvePackage } from "../util/resolve.js";
import type { ToolDef, ToolFactory } from "./types.js";

const shape = {
  dataset: z
    .string()
    .describe("ID/slug датасету АБО його назва (якщо назва — буде автопошук найкращого збігу)"),
};

const schema = z.object(shape);

export const inspectDataset: ToolFactory = (ctx): ToolDef => ({
  name: "inspect_dataset",
  description:
    "Детальна картка одного датасету перед використанням: опис, розпорядник, ліцензія (+URL), свіжість, частота оновлення, і список ресурсів з форматом, розміром та ознакою machine_readable. Приймає ID/slug або назву (автопошук). Далі бери дані через get_dataset_data.",
  inputSchema: shape,
  handler: async (raw) => {
    const args = schema.parse(raw);
    const pkg = await resolvePackage(ctx.ckan, args.dataset);
    const card = toDatasetCard(pkg);
    return capPayload(
      { count: 1, returned: 1, results: [card], more: false, source_url: card.dataset_url },
      ctx.config,
    );
  },
});
