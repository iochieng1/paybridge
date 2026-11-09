import { inject } from "vitest";

import { buildApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config.js";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    JWT_SECRET: "test-jwt-secret-that-is-at-least-32-chars",
  }),
  ...overrides,
});

export const buildTestApp = (overrides: Partial<Config> = {}) =>
  buildApp(testConfig(overrides));
