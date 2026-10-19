import { CkanClient } from "./ckan/client.js";
import { loadConfig } from "./config.js";
import { MIRRORED } from "./registries.js";
import { syncRegistry } from "./mirror/sync.js";
import { createLogger } from "./util/logger.js";

/**
 * Refresh local copies of flagship registries for lookup_record.
 *
 *   MIRROR_DIR=/var/lib/opendata-mcp node dist/sync.js [registry…] [--force] [--inspect]
 *
 * Unchanged resources are skipped. One failing registry doesn't stop the rest;
 * the exit code is non-zero if any failed (so the systemd timer shows it).
 */
async function main(): Promise<number> {
  const config = loadConfig();
  const log = createLogger(config);
  if (!config.mirrorDir) {
    log.error("MIRROR_DIR is not set");
    return 2;
  }
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const inspect = args.includes("--inspect");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const unknown = wanted.filter((k) => !MIRRORED.some((r) => r.key === k));
  if (unknown.length) {
    log.error("unknown registry", { unknown, known: MIRRORED.map((r) => r.key) });
    return 2;
  }

  const ckan = new CkanClient(config, log);
  let failed = 0;
  for (const def of MIRRORED.filter((r) => !wanted.length || wanted.includes(r.key))) {
    try {
      const outcome = await syncRegistry(def, ckan, log, {
        dir: config.mirrorDir,
        userAgent: config.userAgent,
        force,
        inspect,
      });
      if (outcome.status === "inspected") {
        process.stdout.write(`${def.key}:\n${JSON.stringify(outcome.sample, null, 1)}\n`);
      } else {
        log.info("mirror " + outcome.status, { registry: def.key, ...outcome });
      }
    } catch (err) {
      failed++;
      log.error("mirror failed", { registry: def.key, message: (err as Error).message });
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
