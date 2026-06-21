/**
 * Normalize the dirty `res_format` values seen on data.gov.ua:
 * `xls xlsx`, `xlxs`, `.сsv` (Cyrillic с), `DOC`, `application/x-7z-compressed`, ...
 */

// Map of normalized aliases -> canonical format.
const ALIASES: Record<string, string> = {
  "XLS XLSX": "XLSX",
  XLXS: "XLSX",
  XLS: "XLS",
  "X-7Z-COMPRESSED": "7Z",
  "APPLICATION/X-7Z-COMPRESSED": "7Z",
  "TEXT/CSV": "CSV",
  "APPLICATION/JSON": "JSON",
  "APPLICATION/PDF": "PDF",
  "APPLICATION/ZIP": "ZIP",
  GEOJSON: "GEOJSON",
};

/** Canonicalize one raw format string. Returns "" for empty/unknown-empty. */
export function normalizeFormat(raw: string | undefined | null): string {
  if (!raw) return "";
  // NFKC folds compatibility chars; then map Cyrillic homoglyphs to Latin so
  // ".сsv" (Cyrillic с U+0441) becomes "CSV".
  let s = raw.normalize("NFKC").trim();
  s = mapCyrillicHomoglyphs(s);
  s = s.replace(/^\.+/, "").trim().toUpperCase();
  if (!s) return "";
  return ALIASES[s] ?? s;
}

/** Machine-readable (structured) formats worth auto-parsing. */
const MACHINE_READABLE = new Set(["CSV", "JSON", "GEOJSON", "XLSX", "XLS", "XML", "TSV"]);

export function isMachineReadable(format: string | undefined | null): boolean {
  return MACHINE_READABLE.has(normalizeFormat(format));
}

// Cyrillic letters that visually match Latin ones, used in format/file noise.
const HOMOGLYPHS: Record<string, string> = {
  с: "c", С: "C", а: "a", А: "A", е: "e", Е: "E", о: "o", О: "O",
  р: "p", Р: "P", х: "x", Х: "X", і: "i", І: "I", у: "y", У: "Y",
  к: "k", К: "K", м: "m", М: "M", т: "T", в: "B", Т: "T", В: "B",
};

export function mapCyrillicHomoglyphs(s: string): string {
  return s.replace(/[a-zA-Zа-яА-ЯіІ]/gu, (ch) => HOMOGLYPHS[ch] ?? ch);
}
