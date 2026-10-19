import type { CkanResource } from "../ckan/types.js";
import { normalizeFormat } from "./formats.js";

// Preference order for "give me the data": structured + parseable first.
// ZIP is last — flagship registries (ЄДР, debtors) ship zipped; get_dataset_data
// unpacks and parses the best inner file.
const PREFERENCE = ["CSV", "TSV", "JSON", "GEOJSON", "XLSX", "XLS", "ODS", "XML", "ZIP"];

/**
 * Pick the best machine-readable resource from a dataset for get_dataset_data.
 * DataStore-active resources win (queryable without download); then by format
 * preference; ties go to the most recently updated resource (yearly registries
 * like vehicles list 2013…2026 files under one dataset). Returns undefined if
 * nothing parseable exists.
 */
export function pickBestResource(resources: CkanResource[] | undefined): CkanResource | undefined {
  const candidates = (resources ?? []).filter((r) => r.state !== "deleted" && r.url);
  if (candidates.length === 0) return undefined;

  const score = (r: CkanResource): number => {
    const fmt = normalizeFormat(r.format);
    const prefIdx = PREFERENCE.indexOf(fmt);
    if (prefIdx === -1) return -1;
    // datastore_active adds a big boost (no download needed).
    return (r.datastore_active ? 100 : 0) + (PREFERENCE.length - prefIdx);
  };

  let best: CkanResource | undefined;
  let bestScore = 0;
  for (const r of candidates) {
    const s = score(r);
    if (s > bestScore || (s === bestScore && s > 0 && updatedAt(r) > updatedAt(best!))) {
      bestScore = s;
      best = r;
    }
  }
  return best;
}

function updatedAt(r: CkanResource): string {
  return r.last_modified ?? r.created ?? "";
}
