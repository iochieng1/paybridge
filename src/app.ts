import fastifyJwt from "@fastify/jwt";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { Redis } from "ioredis";

import { apiKeyAuth } from "./auth/api-keys.js";
import { authenticate } from "./auth/authenticate.js";
import type { Config } from "./config.js";
import { createDb, type Database } from "./db/client.js";
import { createJobs, type Jobs } from "./jobs/jobs.js";
import {
  createDarajaClient,
  DARAJA_BASE_URLS,
  type DarajaClient,
} from "./mpesa/daraja.js";
import { registerOpenApi } from "./openapi.js";
import { purgeExpiredIdempotencyKeys } from "./payments/idempotency.js";
import { globalLimit } from "./rate-limit/limits.js";
import { createRateLimit } from "./rate-limit/rate-limit.js";
import apiKeyRoutes from "./routes/api-keys.js";
import authRoutes, { ACCESS_TOKEN_TTL_SECONDS } from "./routes/auth.js";
import callbackRoutes from "./routes/callbacks.js";
import healthRoutes from "./routes/health.js";
import merchantRoutes from "./routes/merchants.js";
import paymentRoutes from "./routes/payments.js";
import webhookEndpointRoutes from "./routes/webhook-endpoint.js";
import { deriveEncryptionKey } from "./webhooks/secrets.js";

/** How often expired idempotency keys are deleted. */
const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Database;
    redis: Redis;
    daraja: DarajaClient;
    jobs: Jobs;
    webhookEncryptionKey: Buffer;
  }
}

export type BuildAppOptions = {
  /** Namespace for rate-limit keys in Redis; tests use a unique one per app. */
  rateLimitPrefix?: string;
  /** Where logs go instead of stdout; tests use it to inspect log output. */
  logStream?: NodeJS.WritableStream;
  /** Overrides the Daraja origin picked by MPESA_ENV (tests use a fake server). */
  darajaBaseUrl?: string;
  /** Namespace for BullMQ keys in Redis; tests use a unique one per app. */
  queuePrefix?: string;
  /** Overrides the webhook retry delays (tests use milliseconds). */
  webhookRetryDelaysMs?: number[];
  webhookTimeoutMs?: number;
};

export const buildApp = async (
  config: Config,
  {
    rateLimitPrefix = "ratelimit",
    logStream,
    darajaBaseUrl,
    queuePrefix,
    webhookRetryDelaysMs,
    webhookTimeoutMs,
  }: BuildAppOptions = {},
) => {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
      redact: ["req.headers.authorization", "req.headers['x-api-key']"],
      ...(logStream && { stream: logStream }),
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("redis", redis);
  app.decorate(
    "daraja",
    createDarajaClient({
      consumerKey: config.MPESA_CONSUMER_KEY,
      consumerSecret: config.MPESA_CONSUMER_SECRET,
      shortcode: config.MPESA_SHORTCODE,
      passkey: config.MPESA_PASSKEY,
      baseUrl: darajaBaseUrl ?? DARAJA_BASE_URLS[config.MPESA_ENV],
      redis,
    }),
  );

  const webhookEncryptionKey = deriveEncryptionKey(
    config.WEBHOOK_ENCRYPTION_KEY,
  );
  app.decorate("webhookEncryptionKey", webhookEncryptionKey);
  const jobs = createJobs({
    redisUrl: config.REDIS_URL,
    db,
    daraja: app.daraja,
    log: app.log,
    encryptionKey: webhookEncryptionKey,
    allowPrivateAddresses: config.WEBHOOK_ALLOW_PRIVATE_URLS,
    runWorkers: config.RUN_WORKERS,
    prefix: queuePrefix,
    retryDelaysMs: webhookRetryDelaysMs,
    webhookTimeoutMs,
  });
  app.decorate("jobs", jobs);

  app.decorate("rateLimit", createRateLimit(redis, rateLimitPrefix));
  app.addHook("onRequest", app.rateLimit(globalLimit));

  // Expired keys are already ignored on lookup; this just keeps the table small.
  const purgeTimer = setInterval(() => {
    purgeExpiredIdempotencyKeys(db).then(
      (count) =>
        count > 0 && app.log.info({ count }, "Purged expired idempotency keys"),
      (err: unknown) =>
        app.log.error({ err }, "Failed to purge expired idempotency keys"),
    );
  }, IDEMPOTENCY_PURGE_INTERVAL_MS);
  purgeTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(purgeTimer);
    // Workers first: they finish their current job, which may use the db.
    await jobs.close();
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
  app.decorateRequest("apiKeyId", "");
  app.decorate("apiKeyAuth", apiKeyAuth);

  await registerOpenApi(app);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(merchantRoutes, { prefix: "/v1/merchants" });
  await app.register(apiKeyRoutes, { prefix: "/v1/api-keys" });
  await app.register(paymentRoutes, { prefix: "/v1/payments" });
  await app.register(callbackRoutes, { prefix: "/v1/callbacks" });
  await app.register(webhookEndpointRoutes, {
    prefix: "/v1/webhook-endpoint",
  });

  return app;
};
