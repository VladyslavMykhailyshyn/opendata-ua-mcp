/** Build a Solr `fq` filter-query string from structured filters. */

function quote(value: string): string {
  // Quote values containing spaces/special chars for Solr.
  if (/^[\w.-]+$/u.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export interface DatasetFilters {
  organization?: string;
  category?: string; // group slug
  format?: string; // res_format (normalized upstream)
  tags?: string[];
}

export function buildFq(filters: DatasetFilters): string[] {
  const fq: string[] = [];
  if (filters.organization) fq.push(`organization:${quote(filters.organization)}`);
  if (filters.category) fq.push(`groups:${quote(filters.category)}`);
  if (filters.format) fq.push(`res_format:${quote(filters.format)}`);
  for (const t of filters.tags ?? []) fq.push(`tags:${quote(t)}`);
  return fq;
}

export type SortKey = "relevance" | "modified_desc" | "views_desc" | "created_desc";

export function buildSort(sort: SortKey): string | undefined {
  switch (sort) {
    case "modified_desc":
      return "metadata_modified desc";
    case "created_desc":
      return "metadata_created desc";
    case "views_desc":
      return "views_recent desc";
    case "relevance":
    default:
      return undefined; // Solr default relevance score
  }
}
