/**
 * Minimal CKAN shapes — only the fields we actually consume. Live-verified
 * against data.gov.ua (CKAN 2.7.2). Records carry far more; we deliberately
 * ignore the rest to keep the surface small.
 */

export interface CkanResource {
  id: string;
  name?: string;
  description?: string;
  format?: string;
  mimetype?: string | null;
  url?: string;
  size?: number | string | null;
  datastore_active?: boolean;
  created?: string;
  last_modified?: string | null;
  state?: string;
}

export interface CkanOrganization {
  id: string;
  name?: string;
  title?: string;
  package_count?: number;
}

export interface CkanGroup {
  id: string;
  name: string;
  title?: string;
  display_name?: string;
  description?: string;
  package_count?: number;
}

export interface CkanTag {
  id?: string;
  name: string;
}

export interface CkanPackage {
  id: string;
  name: string;
  title?: string;
  notes?: string;
  organization?: CkanOrganization | null;
  resources?: CkanResource[];
  tags?: CkanTag[];
  groups?: CkanGroup[];
  num_resources?: number;
  num_tags?: number;
  metadata_created?: string;
  metadata_modified?: string;
  license_id?: string;
  license_title?: string;
  license_url?: string;
  language?: string | string[];
  update_frequency?: string;
  url?: string;
  state?: string;
}

export interface CkanFacetItem {
  name: string;
  display_name?: string;
  count: number;
}

export interface CkanFacet {
  title?: string;
  items: CkanFacetItem[];
}

export interface PackageSearchResult {
  count: number;
  results: CkanPackage[];
  search_facets?: Record<string, CkanFacet>;
  facets?: Record<string, Record<string, number>>;
}

export interface DatastoreField {
  id: string;
  type: string;
}

export interface DatastoreSearchResult {
  total: number;
  fields: DatastoreField[];
  records: Record<string, unknown>[];
}

export interface ActivityItem {
  id?: string;
  timestamp?: string;
  activity_type?: string;
  data?: { package?: Partial<CkanPackage> };
}
