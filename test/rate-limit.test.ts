import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { buildApp } from "../src/app.js";
import { paymentsLimit } from "../src/rate-limit/limits.js";
import type { RateLimitOptions } from "../src/rate-limit/rate-limit.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const SECOND = 1000;
const T0 = new Date("2026-01-01T00:00:00Z").getTime();

// Nothing listens on port 1, so every Redis command fails.
const CLOSED_REDIS = "redis://127.0.0.1:1";

describe("rate limiting", () => {
  let app: App | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
    app = undefined;
  });

  /** Test app with GET /limited guarded by the given limiter, keyed by x-client. */
  const appWithLimitedRoute = async (
    options: Partial<RateLimitOptions> = {},
    overrides = {},
  ) => {
    const instance = await buildTestApp(overrides);
    instance.get(
      "/limited",
      {
        preHandler: instance.rateLimit({
          key: (request) => `test:${request.headers["x-client"] as string}`,
          limit: 3,
          windowMs: 60 * SECOND,
          onRedisError: "allow",
          ...options,
        }),
      },
      async () => ({ ok: true }),
    );
    return instance;
  };

  const hit = (client = "a") =>
    app!.inject({
      method: "GET",
      url: "/limited",
      headers: { "x-client": client },
    });

  const at = (offsetMs: number) => vi.setSystemTime(T0 + offsetMs);

  describe("sliding-window log", () => {
    it("returns 429 with a correct Retry-After for request N+1", async () => {
      app = await appWithLimitedRoute();
      vi.useFakeTimers({ toFake: ["Date"] });

      const remaining: string[] = [];
      for (const offset of [0, 10, 20]) {
        at(offset * SECOND);
        const res = await hit();
        expect(res.statusCode).toBe(200);
        expect(res.headers["ratelimit-limit"]).toBe("3");
        remaining.push(res.headers["ratelimit-remaining"] as string);
      }
      expect(remaining).toEqual(["2", "1", "0"]);

      at(30 * SECOND);
      const blocked = await hit();

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["ratelimit-remaining"]).toBe("0");
      // The oldest entry (t=0) leaves the window at t=60s: 30s from now.
      expect(blocked.headers["retry-after"]).toBe("30");
    });

    it("rounds a sub-second Retry-After up to 1", async () => {
      app = await appWithLimitedRoute({ limit: 1 });
      vi.useFakeTimers({ toFake: ["Date"] });

      at(0);
      await hit();
      at(59.5 * SECOND);
      const blocked = await hit();

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBe("1");
    });

    it("slides: frees one slot as each old entry ages out, with no boundary burst", async () => {
      app = await appWithLimitedRoute();
      vi.useFakeTimers({ toFake: ["Date"] });

      for (const offset of [0, 30, 31]) {
        at(offset * SECOND);
        expect((await hit()).statusCode).toBe(200);
      }
      at(59.999 * SECOND);
      expect((await hit()).statusCode).toBe(429);

      // t=60s: only the t=0 entry has aged out, so exactly one request fits.
      // A fixed one-minute window would reset here and allow three more.
      at(60 * SECOND);
      expect((await hit()).statusCode).toBe(200);
      expect((await hit()).statusCode).toBe(429);

      // t=90s: the t=30s entry is gone, freeing one more slot.
      at(90 * SECOND);
      expect((await hit()).statusCode).toBe(200);
      expect((await hit()).statusCode).toBe(429);
    });

    it("does not count rejected requests against the client", async () => {
      app = await appWithLimitedRoute({ limit: 1 });
      vi.useFakeTimers({ toFake: ["Date"] });

      at(0);
      await hit();
      for (const offset of [10, 20, 30, 40, 50]) {
        at(offset * SECOND);
        expect((await hit()).statusCode).toBe(429);
      }

      at(60 * SECOND);
      expect((await hit()).statusCode).toBe(200);
    });

    it("keeps separate buckets per key", async () => {
      app = await appWithLimitedRoute({ limit: 1 });

      expect((await hit("a")).statusCode).toBe(200);
      expect((await hit("a")).statusCode).toBe(429);
      expect((await hit("b")).statusCode).toBe(200);
    });

    it("never exceeds the limit under concurrent requests", async () => {
      app = await appWithLimitedRoute({ limit: 10 });

      const results = await Promise.all(
        Array.from({ length: 50 }, () => hit()),
      );

      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 200)).toHaveLength(10);
      expect(codes.filter((c) => c === 429)).toHaveLength(40);
    });
  });

  describe("global limit", () => {
    it("allows 300 requests per IP per minute", async () => {
      app = await buildTestApp();
      const request = (remoteAddress: string) =>
        app!.inject({ method: "GET", url: "/nope", remoteAddress });

      const first = await Promise.all(
        Array.from({ length: 300 }, () => request("10.0.0.1")),
      );
      expect(first.every((r) => r.statusCode === 404)).toBe(true);

      const over = await request("10.0.0.1");
      expect(over.statusCode).toBe(429);
      expect(over.headers["ratelimit-limit"]).toBe("300");

      expect((await request("10.0.0.2")).statusCode).toBe(404);
    });
  });

  describe("login limit", () => {
    const login = (email: string, remoteAddress = "10.0.0.1") =>
      app!.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress,
        payload: { email, password: "wrong-password" },
      });

    it("allows 5 attempts per IP + email per minute", async () => {
      app = await buildTestApp();
      const email = `limited-${randomUUID()}@example.com`;

      for (let i = 0; i < 5; i++) {
        expect((await login(email)).statusCode).toBe(401);
      }
      const blocked = await login(email.toUpperCase());

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["ratelimit-limit"]).toBe("5");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

      // Other emails from that IP, and that email from other IPs, still work.
      expect(
        (await login(`other-${randomUUID()}@example.com`)).statusCode,
      ).toBe(401);
      expect((await login(email, "10.0.0.2")).statusCode).toBe(401);
    });
  });

  describe("when Redis is down", () => {
    it("fails open for payments (and the global limiter)", async () => {
      app = await buildTestApp({ REDIS_URL: CLOSED_REDIS });
      const warnings: unknown[][] = [];
      app.get(
        "/payments-test",
        {
          // Runs after the global limiter, so only the payments warning is caught.
          onRequest: async (request) => {
            vi.spyOn(request.log, "warn").mockImplementation((...args) => {
              warnings.push(args);
            });
          },
          preHandler: app.rateLimit(
            paymentsLimit((request) => request.headers["x-api-key"] as string),
          ),
        },
        async () => ({ ok: true }),
      );

      const res = await app.inject({
        method: "GET",
        url: "/payments-test",
        headers: { "x-api-key": "pb_test_key" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![1]).toMatch(/fail-open/);
    });

    it("fails closed for login", async () => {
      app = await buildTestApp({ REDIS_URL: CLOSED_REDIS });

      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "a@example.com", password: "whatever" },
      });

      expect(res.statusCode).toBe(503);
    });
  });
});
