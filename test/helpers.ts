import { randomUUID } from "node:crypto";

import { inject } from "vitest";

import { buildApp, type BuildAppOptions } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    JWT_SECRET: "test-jwt-secret-that-is-at-least-32-chars",
    MPESA_CONSUMER_KEY: "test-consumer-key",
    MPESA_CONSUMER_SECRET: "test-consumer-secret",
    MPESA_PASSKEY: "test-passkey",
    PUBLIC_BASE_URL: "https://paybridge.example.com",
    WEBHOOK_ENCRYPTION_KEY: "test-webhook-encryption-key-32-chars-min",
    // Tests deliver webhooks to a receiver on 127.0.0.1.
    WEBHOOK_ALLOW_PRIVATE_URLS: "true",
    // Only the webhook and reconciliation tests start workers.
    RUN_WORKERS: "false",
  }),
  ...overrides,
});

// Test files share one Redis, so each app gets its own rate-limit namespace.
export const buildTestApp = (
  overrides: Partial<Config> = {},
  options: BuildAppOptions = {},
) =>
  buildApp(testConfig(overrides), {
    rateLimitPrefix: `ratelimit:test:${randomUUID()}`,
    queuePrefix: `bull-test-${randomUUID()}`,
    ...options,
  });

type App = Awaited<ReturnType<typeof buildApp>>;

/** Registers a merchant and creates an API key; returns its Authorization header. */
export const merchantWithApiKey = async (app: App) => {
  const email = `merchant-${randomUUID()}@example.com`;
  const password = "correct-horse-battery";
  const registered = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email, password, name: "Duka" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password },
  });
  const accessToken = login.json<{ access_token: string }>().access_token;
  const key = await app.inject({
    method: "POST",
    url: "/v1/api-keys",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return {
    merchantId: registered.json<{ id: string }>().id,
    accessToken,
    authorization: `Bearer ${key.json<{ key: string }>().key}`,
  };
};
