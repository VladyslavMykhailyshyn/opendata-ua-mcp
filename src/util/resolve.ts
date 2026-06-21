import type { CkanClient } from "../ckan/client.js";
import { packageSearch, packageShow } from "../ckan/actions.js";
import type { CkanPackage } from "../ckan/types.js";
import { CkanNotFoundError } from "../ckan/errors.js";
import { normalizeQuery } from "./unicode.js";

// data.gov.ua slugs are mostly UUIDs; otherwise short latin without spaces.
function looksLikeId(s: string): boolean {
  return /^[a-f0-9-]{8,}$/i.test(s) || (/^[\w-]+$/.test(s) && !/\s/.test(s));
}

/**
 * Resolve a user-supplied dataset reference (id/slug OR free-text title) to a
 * full package. Tries package_show for id-looking input; on miss (a one-word
 * topic that isn't a real slug) it falls back to search.
 */
export async function resolvePackage(ckan: CkanClient, ref: string): Promise<CkanPackage> {
  if (looksLikeId(ref)) {
    try {
      return await packageShow(ckan, ref);
    } catch (err) {
      if (!(err instanceof CkanNotFoundError)) throw err;
      // fall through to search
    }
  }
  const search = await packageSearch(ckan, { q: normalizeQuery(ref), rows: 1 });
  if (!search.results.length) {
    throw new CkanNotFoundError(`Датасет не знайдено: "${ref}"`);
  }
  return packageShow(ckan, search.results[0]!.name);
}
