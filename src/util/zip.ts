import AdmZip from "adm-zip";
import { ToolError } from "./errors.js";
import { normalizeFormat } from "./formats.js";

// Same preference as resource-picker: structured + parseable first.
const PREFERENCE = ["CSV", "TSV", "JSON", "GEOJSON", "XLSX", "XLS", "ODS", "XML"];
const MAX_NAMES = 20;

export interface ZipEntry {
  name: string;
  format: string;
  buffer: Buffer;
}

/**
 * Open a ZIP and return its best parseable inner entry (data registries on
 * data.gov.ua — ЄДР, debtors — ship as ZIP with CSV/XML inside). Returns the
 * entry list (capped) too, so callers can report when nothing is parseable.
 *
 * Entries whose declared size exceeds `maxBytes` and encrypted entries are
 * never inflated; only the chosen entry is inflated, exactly once, and its
 * real size is checked afterwards because adm-zip trusts the header.
 */
export function pickBestZipEntry(
  zipBuffer: Buffer,
  maxBytes = Infinity,
): { best?: ZipEntry; names: string[]; skipped: number } {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const names = entries.slice(0, MAX_NAMES).map((e) => e.entryName);

  let chosen: AdmZip.IZipEntry | undefined;
  let chosenFmt = "";
  let bestRank = Infinity;
  let skipped = 0;
  for (const e of entries) {
    const ext = e.entryName.split(".").pop() ?? "";
    const fmt = normalizeFormat(ext);
    const rank = PREFERENCE.indexOf(fmt);
    if (rank === -1) continue;
    if ((e.header.flags & 1) !== 0 || e.header.size > maxBytes) {
      skipped++;
      continue;
    }
    if (rank < bestRank) {
      bestRank = rank;
      chosen = e;
      chosenFmt = fmt;
    }
  }
  if (!chosen) return { names, skipped };

  const buffer = chosen.getData();
  if (buffer.length > maxBytes) {
    throw new ToolError("Файл в архіві більший за ліміт завантаження.");
  }
  return { best: { name: chosen.entryName, format: chosenFmt, buffer }, names, skipped };
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
