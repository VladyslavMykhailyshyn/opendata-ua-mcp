/**
 * Query-side helpers for find_datasets, driven by GSC demand (May–Sep 2026):
 * 40% of impressions are "wrong door" searches for services that are not open
 * data (Дія login, court decisions search, tax cabinet), and multi-word
 * natural queries often return 0: portal search requires every word in its
 * exact form (no stemming — "тролейбуси" ≠ "тролейбус") and ignores OR.
 */

export interface Elsewhere {
  what: string;
  url: string;
}

const W = (word: string) => `(?<!\\p{L})${word}(?!\\p{L})`;

// Services people look for on data.gov.ua that live on another site.
const WRONG_DOORS: { pattern: RegExp; to: Elsewhere }[] = [
  {
    pattern: new RegExp(`${W("(дія|дия)")}|diia`, "u"),
    to: { what: "Портал Дія — держпослуги, вхід у кабінет", url: "https://diia.gov.ua" },
  },
  {
    pattern: /судов\p{L}* рішен|реєстр\p{L}* судов/u,
    to: {
      what: "Єдиний державний реєстр судових рішень — пошук тексту рішень",
      url: "https://reyestr.court.gov.ua",
    },
  },
  {
    pattern: /судов\p{L}* справ|стан\p{L}* розгляд/u,
    to: { what: "Судова влада України — стан розгляду справ", url: "https://court.gov.ua" },
  },
  {
    pattern: /міграційн|паспорт/u,
    to: { what: "Державна міграційна служба", url: "https://dmsu.gov.ua" },
  },
  {
    pattern: /кабінет\p{L}* платник|податков\p{L}* кабінет|електронн\p{L}* кабінет/u,
    to: { what: "Електронний кабінет платника податків", url: "https://cabinet.tax.gov.ua" },
  },
  {
    pattern: /пенсійн\p{L}* фонд/u,
    to: { what: "Пенсійний фонд України — вебпортал", url: "https://portal.pfu.gov.ua" },
  },
  {
    pattern: /opendatabot|опендатабот/u,
    to: {
      what: "Opendatabot — приватний сервіс поверх відкритих даних (не data.gov.ua)",
      url: "https://opendatabot.ua",
    },
  },
];

export function wrongDoors(query: string): Elsewhere[] {
  const q = query.normalize("NFKC").toLowerCase();
  return WRONG_DOORS.filter((d) => d.pattern.test(q)).map((d) => d.to);
}

// Words that carry no topic: prepositions, conjunctions, and portal noise.
const STOPWORDS = new Set([
  "в",
  "у",
  "на",
  "по",
  "до",
  "з",
  "із",
  "зі",
  "за",
  "від",
  "для",
  "про",
  "та",
  "і",
  "й",
  "або",
  "що",
  "як",
  "дані",
  "даних",
  "інформація",
  "україна",
  "україни",
  "україні",
  "data",
  "gov",
  "ua",
  "gov.ua",
  "data.gov.ua",
]);

/**
 * Looser rewrites of a query that found nothing, to try in order. A field
 * prefix (`text:`) switches CKAN from dismax to the Lucene parser, which
 * honours AND/OR and trailing wildcards; cutting word endings stands in for
 * the stemming the portal index lacks. Live-checked 2026-10-19:
 * "тролейбуси полтава" → 0, `text:(тролейбу* AND полтав*)` → 3 relevant.
 */
export function relaxQuery(query: string): string[] {
  const words = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  if (words.length === 0) return [];
  const stems = [...new Set(words.map(stem))];
  const and = `text:(${stems.join(" AND ")})`;
  const or = `text:(${stems.join(" OR ")})`;
  return stems.length > 1 ? [and, or] : [and];
}

/** Crude Ukrainian stem as a prefix wildcard; short words stay exact. */
function stem(word: string): string {
  if (/^\p{N}+$/u.test(word) || word.length <= 4) return word;
  return word.slice(0, word.length >= 7 ? -2 : -1) + "*";
}
