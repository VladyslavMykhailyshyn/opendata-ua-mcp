export function humanSize(bytes: number | string | null | undefined): string | undefined {
  if (bytes === null || bytes === undefined || bytes === "") return undefined;
  const n = typeof bytes === "string" ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Relative age like "2 days ago" from an ISO timestamp. UTC-based, deterministic. */
export function relativeAge(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return undefined;
  const sec = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (sec < 0) return "in the future";
  const steps: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [s, label] of steps) {
    const q = Math.floor(sec / s);
    if (q >= 1) return `${q} ${label}${q > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

// Map common CKAN license_id -> canonical URL (data.gov.ua records often lack license_url).
const LICENSE_URLS: Record<string, string> = {
  "cc-by": "https://creativecommons.org/licenses/by/4.0/",
  "cc-by-sa": "https://creativecommons.org/licenses/by-sa/4.0/",
  "cc-zero": "https://creativecommons.org/publicdomain/zero/1.0/",
  "cc-nc": "https://creativecommons.org/licenses/by-nc/4.0/",
  "odc-pddl": "https://opendatacommons.org/licenses/pddl/1-0/",
  "odc-by": "https://opendatacommons.org/licenses/by/1-0/",
  "odc-odbl": "https://opendatacommons.org/licenses/odbl/1-0/",
  "uk-ogl": "https://www.nationalarchives.gov.uk/doc/open-government-licence/",
};

export function licenseUrl(id: string | undefined, existing?: string): string | undefined {
  if (existing) return existing;
  if (!id) return undefined;
  return LICENSE_URLS[id.toLowerCase()];
}

export function datasetUrl(name: string): string {
  return `https://data.gov.ua/dataset/${name}`;
}
