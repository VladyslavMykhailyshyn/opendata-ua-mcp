import type { CkanPackage, CkanResource } from "../ckan/types.js";
import { normalizeFormat, isMachineReadable } from "./formats.js";
import { datasetUrl, humanSize, licenseUrl, relativeAge } from "./humanize.js";

const SNIPPET_LEN = 200;

function snippet(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const clean = notes.replace(/\s+/g, " ").trim();
  return clean.length > SNIPPET_LEN ? clean.slice(0, SNIPPET_LEN) + "…" : clean;
}

function uniqueFormats(resources: CkanResource[] | undefined): string[] {
  const set = new Set<string>();
  for (const r of resources ?? []) {
    const f = normalizeFormat(r.format);
    if (f) set.add(f);
  }
  return [...set];
}

/** Slim search hit (~150B vs 17KB raw package). Used by find_datasets. */
export interface DatasetHit {
  id: string;
  title: string;
  org_title?: string;
  formats: string[];
  machine_readable: boolean;
  freshness?: string;
  n_resources: number;
  why_relevant?: string;
  dataset_url: string;
}

export function toDatasetHit(pkg: CkanPackage): DatasetHit {
  const formats = uniqueFormats(pkg.resources);
  return {
    id: pkg.name,
    title: pkg.title ?? pkg.name,
    org_title: pkg.organization?.title,
    formats,
    machine_readable: (pkg.resources ?? []).some((r) => isMachineReadable(r.format)),
    freshness: relativeAge(pkg.metadata_modified),
    n_resources: pkg.num_resources ?? pkg.resources?.length ?? 0,
    why_relevant: snippet(pkg.notes),
    dataset_url: datasetUrl(pkg.name),
  };
}

/** Resource line for inspect_dataset / get_dataset_data. */
export interface ResourceLine {
  id: string;
  name?: string;
  format: string;
  size_human?: string;
  machine_readable: boolean;
  has_datastore: boolean;
  downloadable: boolean;
}

export function toResourceLine(r: CkanResource): ResourceLine {
  return {
    id: r.id,
    name: r.name || undefined,
    format: normalizeFormat(r.format),
    size_human: humanSize(r.size),
    machine_readable: isMachineReadable(r.format),
    has_datastore: r.datastore_active === true,
    downloadable: Boolean(r.url),
  };
}

/** Full-but-slim dataset card. Used by inspect_dataset. */
export interface DatasetCard {
  id: string;
  title: string;
  summary?: string;
  organization?: string;
  license?: string;
  license_url?: string;
  language?: string | string[];
  update_frequency?: string;
  created?: string;
  modified?: string;
  freshness?: string;
  formats: string[];
  resources: ResourceLine[];
  dataset_url: string;
}

export function toDatasetCard(pkg: CkanPackage): DatasetCard {
  const resources = (pkg.resources ?? []).filter((r) => r.state !== "deleted");
  return {
    id: pkg.name,
    title: pkg.title ?? pkg.name,
    summary: snippet(pkg.notes),
    organization: pkg.organization?.title,
    license: pkg.license_title ?? pkg.license_id,
    license_url: licenseUrl(pkg.license_id, pkg.license_url),
    language: pkg.language,
    update_frequency: pkg.update_frequency,
    created: pkg.metadata_created,
    modified: pkg.metadata_modified,
    freshness: relativeAge(pkg.metadata_modified),
    formats: uniqueFormats(resources),
    resources: resources.map(toResourceLine),
    dataset_url: datasetUrl(pkg.name),
  };
}
