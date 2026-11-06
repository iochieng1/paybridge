import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

import { runMigrations } from "../src/db/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

// Real Postgres and Redis in throwaway containers: tests exercise the same
// constraints, locks and Lua scripts that production does.
export default async function setup(project: TestProject) {
  const [postgres, redis]: [StartedPostgreSqlContainer, StartedRedisContainer] =
    await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine").start(),
      new RedisContainer("redis:7-alpine").start(),
    ]);

  const databaseUrl = postgres.getConnectionUri();
  await runMigrations(databaseUrl);

  project.provide("databaseUrl", databaseUrl);
  project.provide("redisUrl", redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
