import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from "vitest";

import {
  createDarajaClient,
  DarajaError,
  type DarajaClientOptions,
  TOKEN_REFRESH_MARGIN_SECONDS,
} from "../src/mpesa/daraja.js";
import {
  OAUTH_PATH,
  startFakeDaraja,
  STK_PUSH_PATH,
  STK_QUERY_PATH,
  stkPushAccepted,
} from "./fake-daraja.js";

const CONSUMER_KEY = "fake-consumer-key";
const CONSUMER_SECRET = "fake-consumer-secret";
const SHORTCODE = "174379";
const PASSKEY = "fake-passkey";
// 2026-01-01 21:30:05 UTC is 2026-01-02 00:30:05 in Nairobi.
const NOW = new Date("2026-01-01T21:30:05Z");
const TIMESTAMP = "20260102003005";
const PASSWORD = Buffer.from(`${SHORTCODE}${PASSKEY}${TIMESTAMP}`).toString(
  "base64",
);

describe("Daraja client", () => {
  let daraja: Awaited<ReturnType<typeof startFakeDaraja>>;
  let redis: Redis;
  let cachePrefix: string;

  beforeAll(async () => {
    daraja = await startFakeDaraja();
    redis = new Redis(inject("redisUrl"));
  });

  afterAll(async () => {
    await daraja.close();
    await redis.quit();
  });

  beforeEach(() => {
    daraja.reset();
    // Each test gets its own token cache.
    cachePrefix = `mpesa:test:${randomUUID()}`;
  });

  const client = (overrides: Partial<DarajaClientOptions> = {}) =>
    createDarajaClient({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      shortcode: SHORTCODE,
      passkey: PASSKEY,
      baseUrl: daraja.baseUrl,
      redis,
      cachePrefix,
      now: () => NOW,
      ...overrides,
    });

  const push = (
    target = client(),
    overrides: Partial<
      Parameters<ReturnType<typeof client>["stkPush"]>[0]
    > = {},
  ) =>
    target.stkPush({
      amount: 100,
      phone: "0712 345 678",
      accountReference: "INV-1001",
      description: "Order 1001",
      callbackUrl: "https://paybridge.example.com/v1/mpesa/callback/abc",
      ...overrides,
    });

  const cacheKeys = () => redis.keys(`${cachePrefix}:oauth:*`);

  describe("OAuth token", () => {
    it("fetches a token with HTTP Basic auth", async () => {
      const token = await client().accessToken();

      expect(token).toBe("token-1");
      const [request] = daraja.to(OAUTH_PATH);
      expect(request?.method).toBe("GET");
      expect(request?.headers.authorization).toBe(
        `Basic ${Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64")}`,
      );
    });

    it("caches the token in Redis until shortly before it expires", async () => {
      const first = client();
      await first.accessToken();
      await first.accessToken();
      // A second instance (e.g. another server process) shares the cache.
      await client().accessToken();

      expect(daraja.to(OAUTH_PATH)).toHaveLength(1);
      const [key] = await cacheKeys();
      expect(key).toBeDefined();
      expect(key).not.toContain(CONSUMER_KEY);
      const ttl = await redis.ttl(key!);
      expect(ttl).toBeGreaterThan(3599 - TOKEN_REFRESH_MARGIN_SECONDS - 5);
      expect(ttl).toBeLessThanOrEqual(3599 - TOKEN_REFRESH_MARGIN_SECONDS);
    });

    it("fetches a new token once the cached one has expired", async () => {
      const target = client();
      expect(await target.accessToken()).toBe("token-1");

      // Simulate the cache entry expiring.
      const [key] = await cacheKeys();
      await redis.del(key!);

      expect(await target.accessToken()).toBe("token-2");
      expect(daraja.to(OAUTH_PATH)).toHaveLength(2);
    });

    it("keeps short-lived tokens cached for at least a second", async () => {
      daraja.on(OAUTH_PATH, () => ({
        status: 200,
        body: { access_token: "short", expires_in: "30" },
      }));

      await client().accessToken();

      const [key] = await cacheKeys();
      expect(await redis.ttl(key!)).toBe(1);
    });

    it("shares one in-flight fetch between concurrent callers", async () => {
      const target = client();

      const tokens = await Promise.all(
        Array.from({ length: 10 }, () => target.accessToken()),
      );

      expect(new Set(tokens)).toEqual(new Set(["token-1"]));
      expect(daraja.to(OAUTH_PATH)).toHaveLength(1);
    });

    it("throws a DarajaError for bad credentials and caches nothing", async () => {
      daraja.on(OAUTH_PATH, () => ({
        status: 400,
        body: {
          requestId: "req-1",
          errorCode: "400.008.01",
          errorMessage: "Invalid Authentication passed",
        },
      }));

      const error = await client()
        .accessToken()
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(DarajaError);
      expect(error).toMatchObject({
        message: "Invalid Authentication passed",
        details: { status: 400, code: "400.008.01", requestId: "req-1" },
      });
      expect(await cacheKeys()).toEqual([]);
    });

    it("still works when Redis is unavailable", async () => {
      const brokenRedis = new Redis("redis://127.0.0.1:1", {
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      brokenRedis.on("error", () => undefined);

      try {
        const result = await push(client({ redis: brokenRedis }));
        expect(result.checkoutRequestId).toBe(
          stkPushAccepted.CheckoutRequestID,
        );
      } finally {
        brokenRedis.disconnect();
      }
    });
  });

  describe("stkPush", () => {
    it("sends a CustomerPayBillOnline request with the password and timestamp", async () => {
      const result = await push();

      expect(result).toEqual({
        merchantRequestId: stkPushAccepted.MerchantRequestID,
        checkoutRequestId: stkPushAccepted.CheckoutRequestID,
        responseDescription: stkPushAccepted.ResponseDescription,
        customerMessage: stkPushAccepted.CustomerMessage,
      });

      const [request] = daraja.to(STK_PUSH_PATH);
      expect(request?.method).toBe("POST");
      expect(request?.headers.authorization).toBe("Bearer token-1");
      expect(request?.headers["content-type"]).toBe("application/json");
      expect(request?.body).toEqual({
        BusinessShortCode: SHORTCODE,
        Password: PASSWORD,
        Timestamp: TIMESTAMP,
        TransactionType: "CustomerPayBillOnline",
        Amount: 100,
        PartyA: "254712345678",
        PartyB: SHORTCODE,
        PhoneNumber: "254712345678",
        CallBackURL: "https://paybridge.example.com/v1/mpesa/callback/abc",
        AccountReference: "INV-1001",
        TransactionDesc: "Order 1001",
      });
    });

    it("reuses the cached token across requests", async () => {
      const target = client();
      await push(target);
      await push(target);

      expect(daraja.to(OAUTH_PATH)).toHaveLength(1);
      expect(daraja.to(STK_PUSH_PATH)).toHaveLength(2);
    });

    it("refreshes the token and retries once when Daraja rejects it", async () => {
      let calls = 0;
      daraja.on(STK_PUSH_PATH, (request) => {
        calls += 1;
        return request.headers.authorization === "Bearer token-1"
          ? {
              status: 401,
              body: {
                requestId: "req-2",
                errorCode: "404.001.04",
                errorMessage: "Invalid Access Token",
              },
            }
          : { status: 200, body: stkPushAccepted };
      });

      const result = await push();

      expect(result.checkoutRequestId).toBe(stkPushAccepted.CheckoutRequestID);
      expect(calls).toBe(2);
      expect(
        daraja.to(STK_PUSH_PATH).map((r) => r.headers.authorization),
      ).toEqual(["Bearer token-1", "Bearer token-2"]);
    });

    it("gives up after one retry if the new token is rejected too", async () => {
      daraja.on(STK_PUSH_PATH, () => ({
        status: 401,
        body: { errorCode: "404.001.04", errorMessage: "Invalid Access Token" },
      }));

      await expect(push()).rejects.toMatchObject({
        name: "DarajaError",
        details: { status: 401, code: "404.001.04" },
      });
      expect(daraja.to(STK_PUSH_PATH)).toHaveLength(2);
    });

    it("throws a DarajaError with Daraja's error code", async () => {
      daraja.on(STK_PUSH_PATH, () => ({
        status: 400,
        body: {
          requestId: "req-3",
          errorCode: "400.002.02",
          errorMessage: "Bad Request - Invalid PhoneNumber",
        },
      }));

      await expect(push()).rejects.toMatchObject({
        name: "DarajaError",
        message: "Bad Request - Invalid PhoneNumber",
        details: { status: 400, code: "400.002.02", requestId: "req-3" },
      });
    });

    it("throws when Daraja doesn't accept the request (ResponseCode != 0)", async () => {
      daraja.on(STK_PUSH_PATH, () => ({
        status: 200,
        body: {
          ...stkPushAccepted,
          ResponseCode: "1",
          ResponseDescription: "Rejected",
        },
      }));

      await expect(push()).rejects.toMatchObject({
        name: "DarajaError",
        message: "Rejected",
        details: { code: "1" },
      });
    });

    it.each([
      [
        "a 5xx with a non-JSON body",
        { status: 503, body: "<html>down</html>" },
      ],
      ["an unexpected response shape", { status: 200, body: { ok: true } }],
    ])("throws a DarajaError for %s", async (_, reply) => {
      daraja.on(STK_PUSH_PATH, () => reply);

      await expect(push()).rejects.toBeInstanceOf(DarajaError);
    });

    it("times out if Daraja doesn't answer", async () => {
      daraja.on(STK_PUSH_PATH, () => "hang");

      const error = await push(client({ timeoutMs: 200 })).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(DarajaError);
      expect((error as DarajaError).details.cause).toMatchObject({
        name: "TimeoutError",
      });
    });

    it.each([
      ["an invalid phone number", { phone: "0201234567" }],
      ["a fractional amount", { amount: 10.5 }],
      ["a zero amount", { amount: 0 }],
      [
        "an account reference over 12 characters",
        { accountReference: "A".repeat(13) },
      ],
      ["a description over 13 characters", { description: "D".repeat(14) }],
      ["a non-URL callback", { callbackUrl: "not-a-url" }],
    ])("rejects %s without calling Daraja", async (_, overrides) => {
      await expect(push(client(), overrides)).rejects.toThrow();

      expect(daraja.requests).toEqual([]);
    });
  });

  describe("stkQuery", () => {
    const query = (target = client()) =>
      target.stkQuery("ws_CO_020120260030051234567890");

    it("sends the checkout request id with the password and timestamp", async () => {
      daraja.on(STK_QUERY_PATH, () => ({
        status: 200,
        body: {
          ResponseCode: "0",
          ResponseDescription:
            "The service request has been accepted successsfully",
          MerchantRequestID: "29115-34620561-1",
          CheckoutRequestID: "ws_CO_020120260030051234567890",
          ResultCode: "0",
          ResultDesc: "The service request is processed successfully.",
        },
      }));

      const result = await query();

      expect(result).toEqual({
        status: "completed",
        resultCode: 0,
        resultDesc: "The service request is processed successfully.",
        merchantRequestId: "29115-34620561-1",
        checkoutRequestId: "ws_CO_020120260030051234567890",
      });
      const [request] = daraja.to(STK_QUERY_PATH);
      expect(request?.headers.authorization).toBe("Bearer token-1");
      expect(request?.body).toEqual({
        BusinessShortCode: SHORTCODE,
        Password: PASSWORD,
        Timestamp: TIMESTAMP,
        CheckoutRequestID: "ws_CO_020120260030051234567890",
      });
    });

    it("reports a failed payment's result code", async () => {
      daraja.on(STK_QUERY_PATH, () => ({
        status: 200,
        body: {
          ResponseCode: "0",
          ResponseDescription:
            "The service request has been accepted successsfully",
          MerchantRequestID: "29115-34620561-1",
          CheckoutRequestID: "ws_CO_020120260030051234567890",
          ResultCode: "1032",
          ResultDesc: "Request cancelled by user",
        },
      }));

      expect(await query()).toMatchObject({
        status: "completed",
        resultCode: 1032,
        resultDesc: "Request cancelled by user",
      });
    });

    it("returns pending while the customer hasn't responded", async () => {
      daraja.on(STK_QUERY_PATH, () => ({
        status: 500,
        body: {
          requestId: "req-4",
          errorCode: "500.001.1001",
          errorMessage: "The transaction is being processed",
        },
      }));

      expect(await query()).toEqual({ status: "pending" });
    });

    it("throws a DarajaError for other errors", async () => {
      daraja.on(STK_QUERY_PATH, () => ({
        status: 400,
        body: {
          requestId: "req-5",
          errorCode: "400.002.02",
          errorMessage: "Bad Request - Invalid CheckoutRequestID",
        },
      }));

      await expect(query()).rejects.toMatchObject({
        name: "DarajaError",
        details: { status: 400, code: "400.002.02" },
      });
    });
  });
});
