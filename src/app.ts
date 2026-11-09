import fastifyJwt from "@fastify/jwt";
import Fastify from "fastify";
import { Redis } from "ioredis";

import { authenticate } from "./auth/authenticate.js";
import type { Config } from "./config.js";
import { createDb, type Database } from "./db/client.js";
import authRoutes, { ACCESS_TOKEN_TTL_SECONDS } from "./routes/auth.js";
import healthRoutes from "./routes/health.js";
import merchantRoutes from "./routes/merchants.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    redis: Redis;
  }
}

export const buildApp = async (config: Config) => {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
      redact: ["req.headers.authorization", "req.headers['x-api-key']"],
    },
  });

  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("redis", redis);

  app.addHook("onClose", async () => {
    await Promise.allSettled([sql.end(), redis.quit()]);
  });

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    // @fastify/jwt treats a numeric expiresIn as seconds.
    sign: { algorithm: "HS256", expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    verify: { algorithms: ["HS256"] },
  });
  app.decorateRequest("merchant");
  app.decorate("authenticate", authenticate);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(merchantRoutes, { prefix: "/v1/merchants" });

  return app;
};
