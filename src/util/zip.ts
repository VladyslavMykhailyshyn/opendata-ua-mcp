import AdmZip from "adm-zip";
import { normalizeFormat } from "./formats.js";

// Same preference as resource-picker: structured + parseable first.
const PREFERENCE = ["CSV", "TSV", "JSON", "GEOJSON", "XLSX", "XLS", "ODS", "XML"];

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

/**
 * XLSX and ODS are ZIP containers too ("PK" magic). Tell them apart from data
 * archives by the entry names their specs fix (`[Content_Types].xml`/`xl/…`,
 * `mimetype`/`content.xml`). Walks the first local headers only, so it works
 * on a truncated buffer.
 */
export function officeContainerFormat(buffer: Buffer): "XLSX" | "ODS" | undefined {
  let offset = 0;
  for (let n = 0; n < 8 && offset + 30 <= buffer.length; n++) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) return undefined;
    const flags = buffer.readUInt16LE(offset + 6);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLen);
    if (name === "mimetype" || name === "content.xml") return "ODS";
    if (name === "[Content_Types].xml" || name.startsWith("xl/")) return "XLSX";
    // Sizes live in a trailing data descriptor (flag bit 3): can't skip ahead.
    if (flags & 0x08) return undefined;
    offset += 30 + nameLen + extraLen + compressedSize;
  }
  return undefined;
}
