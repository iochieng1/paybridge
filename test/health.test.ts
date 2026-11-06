import { afterEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

describe("GET /health", () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports ok when Postgres and Redis are reachable", async () => {
    app = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      checks: { db: "ok", redis: "ok" },
    });
  });

  it("returns 503 and names the failing dependency", async () => {
    // Nothing listens on port 1, so every Redis command fails.
    app = await buildTestApp({ REDIS_URL: "redis://127.0.0.1:1" });

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "degraded",
      checks: { db: "ok", redis: "error" },
    });
  });
});
