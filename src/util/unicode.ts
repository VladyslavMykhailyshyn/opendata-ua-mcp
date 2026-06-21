import { mapCyrillicHomoglyphs } from "./formats.js";

/**
 * Normalize a user search query. Cyrillic/Latin homoglyphs and Roman numerals
 * written in Cyrillic (VІІ with Cyrillic І) break Solr matching on data.gov.ua
 * (docs/3.8 §C). We don't rewrite the user's Cyrillic words (those are real
 * Ukrainian); we only NFKC-fold and, for tokens that look like ASCII/Roman,
 * expand to match both spellings.
 */
export function normalizeQuery(q: string): string {
  return q.normalize("NFKC").trim();
}

/**
 * For an all-letters token that could be a Cyrillic-homoglyph of a Latin word
 * (or vice versa), produce an OR-expansion so Solr finds either spelling.
 * Kept conservative: only expands when the homoglyph mapping actually changes
 * the token.
 */
export function expandHomoglyphToken(token: string): string {
  const latin = mapCyrillicHomoglyphs(token);
  if (latin !== token && /^[A-Za-z]+$/.test(latin)) {
    return `(${token} OR ${latin})`;
  }
  return token;
}
