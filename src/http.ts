import { loadConfig } from "./config.js";
import { createHttpApp } from "./http-app.js";
import { createLogger } from "./util/logger.js";

function main(): void {
  const config = loadConfig();
  const log = createLogger(config);
  const app = createHttpApp({ config, log });

  app.listen(config.httpPort, config.httpHost, () => {
    log.info("opendata-ua-mcp ready (http)", {
      url: `http://${config.httpHost}:${config.httpPort}/mcp`,
    });
  });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    app.close(() => process.exit(0));
    // Don't hang on keep-alive sockets.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (err) {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
}
