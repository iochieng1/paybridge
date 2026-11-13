import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  // Registers the every-minute reconciliation job; a no-op if it exists.
  await app.jobs.start();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
