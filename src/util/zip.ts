import AdmZip from "adm-zip";
import { normalizeFormat } from "./formats.js";

// Same preference as resource-picker: structured + parseable first.
const PREFERENCE = ["CSV", "TSV", "JSON", "GEOJSON", "XLSX", "XLS", "XML"];

export interface ZipEntry {
  name: string;
  format: string;
  buffer: Buffer;
}

/**
 * Open a ZIP and return its best parseable inner entry (data registries on
 * data.gov.ua — ЄДР, debtors — ship as ZIP with CSV/XML inside). Returns the
 * full entry list too, so callers can report when nothing is parseable.
 */
export function pickBestZipEntry(zipBuffer: Buffer): { best?: ZipEntry; names: string[] } {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const names = entries.map((e) => e.entryName);

  let best: ZipEntry | undefined;
  let bestRank = Infinity;
  for (const e of entries) {
    const ext = e.entryName.split(".").pop() ?? "";
    const fmt = normalizeFormat(ext);
    const rank = PREFERENCE.indexOf(fmt);
    if (rank === -1) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = { name: e.entryName, format: fmt, buffer: e.getData() };
    }
  }
  return { best, names };
}
