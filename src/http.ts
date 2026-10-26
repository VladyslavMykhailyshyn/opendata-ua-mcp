import { loadConfig } from "./config.js";
import { createHttpApp, drainHttpApp } from "./http-app.js";
import { createLogger } from "./util/logger.js";

// systemd sends SIGKILL at TimeoutStopSec=30; stay well inside it.
const DRAIN_TIMEOUT_MS = 20_000;

function main(): void {
  const config = loadConfig();
  const log = createLogger(config);
  const app = createHttpApp({ config, log });

  app.on("error", (err: NodeJS.ErrnoException) => {
    log.error("http server error", { code: err.code, message: err.message });
    process.exit(1);
  });
  app.listen(config.httpPort, config.httpHost, () => {
    log.info("opendata-ua-mcp ready (http)", {
      url: `http://${config.httpHost}:${config.httpPort}/mcp`,
    });
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      log.warn("second signal, exiting now", { signal });
      process.exit(0);
    }
    stopping = true;
    log.info("shutting down", { signal });
    drainHttpApp(app);
    // close() stops listening and resolves once in-flight requests finish
    // and their sockets close; after the grace period the rest are cut.
    const force = setTimeout(() => {
      log.warn("drain timeout, closing in-flight connections");
      app.closeAllConnections();
    }, DRAIN_TIMEOUT_MS);
    force.unref();
    app.close(() => {
      clearTimeout(force);
      log.info("stopped");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), DRAIN_TIMEOUT_MS + 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // A rejected promise nobody awaited is a bug, not a reason to drop every
  // client; an uncaught exception leaves state unknown, so restart.
  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error("unhandled rejection", { message: err.message, stack: err.stack });
  });
  process.on("uncaughtException", (err: Error) => {
    log.error("uncaught exception", { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
}
