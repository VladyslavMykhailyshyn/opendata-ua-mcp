import type { DatastoreField } from "../ckan/types.js";

// CKAN DataStore internal columns we never want to surface (token noise).
const INTERNAL = new Set(["_id", "_full_text"]);

export function cleanFields(fields: DatastoreField[]): { col: string; type: string }[] {
  return fields.filter((f) => !INTERNAL.has(f.id)).map((f) => ({ col: f.id, type: f.type }));
}

export function cleanRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!INTERNAL.has(k)) out[k] = v;
    }
    return out;
  });
}
