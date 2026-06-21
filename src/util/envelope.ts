import type { Config } from "../config.js";

/** Uniform response envelope for every data-returning tool. */
export interface Envelope<T> {
  count: number; // total available upstream
  returned: number; // items in this response
  results: T[];
  more: boolean;
  next_offset?: number;
  source_url: string; // human/canonical data.gov.ua link for verification
  note?: string;
}

export function makeEnvelope<T>(args: {
  count: number;
  results: T[];
  offset: number;
  sourceUrl: string;
  note?: string;
}): Envelope<T> {
  const returned = args.results.length;
  const more = args.offset + returned < args.count;
  return {
    count: args.count,
    returned,
    results: args.results,
    more,
    ...(more ? { next_offset: args.offset + returned } : {}),
    source_url: args.sourceUrl,
    ...(args.note ? { note: args.note } : {}),
  };
}

/**
 * Guard against blowing the context window. If a payload exceeds the configured
 * char ceiling, drop trailing results and annotate. Returns serialized JSON.
 */
export function capPayload<T>(env: Envelope<T>, config: Pick<Config, "maxResponseChars">): string {
  let json = JSON.stringify(env);
  if (json.length <= config.maxResponseChars) return json;

  const capped = { ...env, results: [...env.results] };
  while (capped.results.length > 1 && JSON.stringify(capped).length > config.maxResponseChars) {
    capped.results.pop();
  }
  capped.returned = capped.results.length;
  capped.more = true;
  capped.next_offset = (env.next_offset ?? env.returned) - (env.returned - capped.returned);
  capped.note =
    (env.note ? env.note + " " : "") +
    `Response truncated to fit context budget (${capped.returned}/${env.count}). Use next_offset or source_url for the rest.`;
  json = JSON.stringify(capped);
  return json;
}
