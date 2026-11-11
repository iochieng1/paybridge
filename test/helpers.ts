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
    ...options,
  });
