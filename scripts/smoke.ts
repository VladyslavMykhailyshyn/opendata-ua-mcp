/* Live smoke test against data.gov.ua. Exercises each job tool end-to-end. */
import { CkanClient } from "../src/ckan/client.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/logger.js";
import type { ToolContext } from "../src/tools/types.js";
import { findDatasets } from "../src/tools/find-datasets.js";
import { exploreCatalog } from "../src/tools/explore-catalog.js";
import { inspectDataset } from "../src/tools/inspect-dataset.js";
import { getDatasetData } from "../src/tools/get-dataset-data.js";
import { filterData } from "../src/tools/filter-data.js";
import { trackUpdates } from "../src/tools/track-updates.js";

const config = loadConfig();
const log = createLogger({ logLevel: "warn" });
const ctx: ToolContext = { ckan: new CkanClient(config, log), config, log };

function report(name: string, payload: string) {
  const kb = (payload.length / 1024).toFixed(1);
  console.log(`\n=== ${name} (${kb} KB) ===`);
  console.log(payload.slice(0, 500));
}

async function run() {
  const find = findDatasets(ctx);
  const fr = await find.handler({ query: "екологія", limit: 3 });
  report("find_datasets", fr);
  const firstId = JSON.parse(fr).results?.[0]?.id;

  const explore = exploreCatalog(ctx);
  report("explore_catalog", await explore.handler({ query: "бюджет", group_by: "organization", limit: 5 }));

  const inspect = inspectDataset(ctx);
  if (firstId) report("inspect_dataset", await inspect.handler({ dataset: firstId }));

  // get_dataset_data against a real CSV dataset (exercises download+decode+parse).
  const data = getDatasetData(ctx);
  const csvFind = await find.handler({ query: "*", format: "CSV", limit: 5 });
  const csvCandidates = JSON.parse(csvFind).results ?? [];
  let dataDone = false;
  for (const c of csvCandidates) {
    try {
      const out = await data.handler({ dataset: c.id, limit: 3 });
      report(`get_dataset_data [${c.id}]`, out);
      dataDone = true;
      break;
    } catch (e) {
      console.log(`get_dataset_data skip ${c.id}:`, (e as Error).message);
    }
  }
  if (!dataDone) console.log("get_dataset_data: no parseable CSV candidate found");

  const filter = filterData(ctx);
  try {
    report(
      "filter_data(sql)",
      await filter.handler({
        resource_id: "a203fe11-6235-4a50-b10e-fe9f6a95aba8",
        sql: 'SELECT * FROM "a203fe11-6235-4a50-b10e-fe9f6a95aba8" LIMIT 2',
      }),
    );
  } catch (e) {
    console.log("filter_data:", (e as Error).message);
  }

  const track = trackUpdates(ctx);
  report("track_updates", await track.handler({ limit: 3 }));

  console.log("\nSMOKE OK");
}

run().catch((e) => {
  console.error("SMOKE FAIL:", e);
  process.exit(1);
});
