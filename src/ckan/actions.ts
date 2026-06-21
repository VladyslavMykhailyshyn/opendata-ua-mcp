import type { CkanClient } from "./client.js";
import type {
  ActivityItem,
  CkanGroup,
  CkanPackage,
  DatastoreSearchResult,
  PackageSearchResult,
} from "./types.js";

/**
 * Thin wrappers over individual CKAN actions. These are internal building
 * blocks composed by the job tools — they are NOT exposed as MCP tools.
 */

export interface PackageSearchParams {
  q?: string;
  fq?: string[];
  rows?: number;
  start?: number;
  sort?: string;
  facetFields?: string[];
  facetLimit?: number;
}

export function packageSearch(
  ckan: CkanClient,
  p: PackageSearchParams,
): Promise<PackageSearchResult> {
  const params: Record<string, unknown> = {
    q: p.q ?? "*:*",
    rows: p.rows ?? 5,
    start: p.start ?? 0,
  };
  if (p.fq && p.fq.length) params.fq = p.fq.join(" AND ");
  if (p.sort) params.sort = p.sort;
  if (p.facetFields && p.facetFields.length) {
    params.facet = "true";
    params["facet.field"] = p.facetFields;
    params["facet.limit"] = p.facetLimit ?? 10;
  }
  return ckan.call<PackageSearchResult>("package_search", params);
}

export function packageShow(ckan: CkanClient, id: string): Promise<CkanPackage> {
  return ckan.call<CkanPackage>("package_show", { id });
}

export function resourceShow(ckan: CkanClient, id: string): Promise<import("./types.js").CkanResource> {
  return ckan.call("resource_show", { id });
}

export function groupList(ckan: CkanClient): Promise<CkanGroup[]> {
  return ckan.call<CkanGroup[]>("group_list", { all_fields: true }, { cache: true });
}

export function licenseList(ckan: CkanClient): Promise<{ id: string; title?: string; url?: string }[]> {
  return ckan.call("license_list", {}, { cache: true });
}

export function datastoreSearch(
  ckan: CkanClient,
  params: {
    resource_id: string;
    q?: string;
    filters?: Record<string, unknown>;
    fields?: string[];
    limit?: number;
    offset?: number;
    sort?: string;
  },
): Promise<DatastoreSearchResult> {
  const p: Record<string, unknown> = { resource_id: params.resource_id, limit: params.limit ?? 10 };
  if (params.q) p.q = params.q;
  if (params.filters) p.filters = params.filters;
  if (params.fields) p.fields = params.fields.join(",");
  if (params.offset) p.offset = params.offset;
  if (params.sort) p.sort = params.sort;
  return ckan.call<DatastoreSearchResult>("datastore_search", p);
}

export function datastoreSearchSql(
  ckan: CkanClient,
  sql: string,
): Promise<DatastoreSearchResult> {
  return ckan.call<DatastoreSearchResult>("datastore_search_sql", { sql });
}

/** datastore_info requires POST (GET returns 400). */
export function datastoreInfo(ckan: CkanClient, id: string): Promise<unknown> {
  return ckan.call("datastore_info", { id }, { method: "POST" });
}

export function recentlyChanged(ckan: CkanClient, limit: number): Promise<ActivityItem[]> {
  return ckan.call<ActivityItem[]>("recently_changed_packages_activity_list", { limit });
}

export function statusShow(ckan: CkanClient): Promise<{ ckan_version?: string }> {
  return ckan.call("status_show", {}, { cache: true });
}
