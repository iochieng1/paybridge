import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { idempotencyKeys, paymentEvents, payments } from "../src/db/schema.js";
import { purgeExpiredIdempotencyKeys } from "../src/payments/idempotency.js";
import { hashCallbackToken } from "../src/payments/payments.js";
import { type Handler, startFakeDaraja, STK_PUSH_PATH } from "./fake-daraja.js";
import { buildTestApp, merchantWithApiKey } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

type Page = { data: PaymentBody[]; next_cursor: string | null };

type PaymentBody = {
  id: string;
  status: string;
  amount: number;
  phone: string;
  reference: string;
  checkout_request_id: string | null;
  result_desc: string | null;
  completed_at: string | null;
};

const PUBLIC_BASE_URL = "https://paybridge.example.com";

const validBody = {
  phone: "0712 345 678",
  amount: 1500,
  reference: "INV-1001",
  description: "Order 1001",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Accepts every push with a fresh CheckoutRequestID, optionally after a delay. */
const acceptPushes = (delayMs = 0): Handler => {
  let count = 0;
  return async () => {
    if (delayMs) await sleep(delayMs);
    count += 1;
    return {
      status: 200,
      body: {
        MerchantRequestID: `29115-${count}`,
        CheckoutRequestID: `ws_CO_${randomUUID()}`,
        ResponseCode: "0",
        ResponseDescription: "Success. Request accepted for processing",
        CustomerMessage: "Success. Request accepted for processing",
      },
    };
  };
};

describe("payments", () => {
  let app: App;
  let daraja: Awaited<ReturnType<typeof startFakeDaraja>>;

  beforeAll(async () => {
    daraja = await startFakeDaraja();
    app = await buildTestApp(
      { PUBLIC_BASE_URL },
      { darajaBaseUrl: daraja.baseUrl },
    );
  });

  afterAll(async () => {
    await app.close();
    await daraja.close();
  });

  beforeEach(() => {
    daraja.reset();
    daraja.on(STK_PUSH_PATH, acceptPushes());
  });

  const pay = (
    authorization: string,
    {
      key = randomUUID(),
      body = validBody as Record<string, unknown>,
    }: { key?: string | null; body?: Record<string, unknown> } = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: {
        authorization,
        ...(key !== null && { "idempotency-key": key }),
      },
      payload: body,
    });

  const pushes = () => daraja.to(STK_PUSH_PATH);

  const events = async (paymentId: string) =>
    (
      await app.db
        .select({ type: paymentEvents.type, payload: paymentEvents.payload })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, paymentId))
        .orderBy(paymentEvents.id)
    ).map((event) => event.type);

  describe("POST /v1/payments", () => {
    it("requires an API key, not an access token", async () => {
      const { accessToken } = await merchantWithApiKey(app);

      expect((await pay("")).statusCode).toBe(401);
      expect((await pay(`Bearer ${accessToken}`)).statusCode).toBe(401);
      expect(pushes()).toHaveLength(0);
    });

    it("requires an Idempotency-Key header", async () => {
      const { authorization } = await merchantWithApiKey(app);

      const res = await pay(authorization, { key: null });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Idempotency-Key");
      expect(pushes()).toHaveLength(0);
    });

    it.each([
      ["zero", { amount: 0 }],
      ["negative", { amount: -5 }],
      ["fractional", { amount: 10.5 }],
      ["a string", { amount: "100" }],
      ["above the M-Pesa maximum", { amount: 250_001 }],
      ["a non-Kenyan phone", { phone: "+44 7700 900123" }],
      ["a reference over 12 characters", { reference: "INV-1001-EXTRA" }],
    ])("rejects an amount or field that is %s", async (_, override) => {
      const { authorization } = await merchantWithApiKey(app);

      const res = await pay(authorization, {
        body: { ...validBody, ...override },
      });

      expect(res.statusCode).toBe(400);
      expect(pushes()).toHaveLength(0);
    });

    it("sends the STK push and returns 202 PENDING with the checkout id stored", async () => {
      const { authorization, merchantId } = await merchantWithApiKey(app);

      const res = await pay(authorization);

      expect(res.statusCode).toBe(202);
      const body = res.json<PaymentBody>();
      expect(body).toMatchObject({
        status: "PENDING",
        amount: 1500,
        phone: "254712345678",
        reference: "INV-1001",
      });

      const [push] = pushes();
      const sent = push!.body as Record<string, string | number>;
      expect(sent.Amount).toBe(1500);
      expect(sent.PartyA).toBe("254712345678");
      expect(sent.AccountReference).toBe("INV-1001");

      // A per-payment secret callback URL; only the token's hash is stored.
      const callback = new URL(String(sent.CallBackURL));
      expect(callback.origin).toBe(PUBLIC_BASE_URL);
      const token = callback.pathname.replace("/v1/callbacks/mpesa/", "");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const [row] = await app.db
        .select()
        .from(payments)
        .where(eq(payments.id, body.id));
      expect(row!.merchantId).toBe(merchantId);
      expect(row!.checkoutRequestId).toBe(body.checkout_request_id);
      expect(row!.checkoutRequestId).toMatch(/^ws_CO_/);
      expect(row!.callbackTokenHash).toBe(hashCallbackToken(token));
      expect(row!.callbackTokenHash).not.toContain(token);

      expect(await events(body.id)).toEqual(["created", "stk_push_accepted"]);
    });

    it("gives every payment a different callback token", async () => {
      const { authorization } = await merchantWithApiKey(app);

      await pay(authorization);
      await pay(authorization);

      const [first, second] = pushes().map(
        (push) => (push.body as { CallBackURL: string }).CallBackURL,
      );
      expect(first).not.toBe(second);
    });

    it("replays the stored response for the same key and body", async () => {
      const { authorization } = await merchantWithApiKey(app);

      const first = await pay(authorization, { key: "order-1" });
      const second = await pay(authorization, { key: "order-1" });

      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(first.headers["idempotent-replayed"]).toBeUndefined();
      expect(pushes()).toHaveLength(1);
    });

    it("treats the same fields in a different order or phone format as the same body", async () => {
      const { authorization } = await merchantWithApiKey(app);

      await pay(authorization, { key: "order-2" });
      const second = await pay(authorization, {
        key: "order-2",
        body: {
          description: "Order 1001",
          reference: "INV-1001",
          amount: 1500,
          phone: "+254712345678",
        },
      });

      expect(second.statusCode).toBe(202);
      expect(pushes()).toHaveLength(1);
    });

    it("returns 422 for the same key with a different body", async () => {
      const { authorization } = await merchantWithApiKey(app);

      await pay(authorization, { key: "order-3" });
      const res = await pay(authorization, {
        key: "order-3",
        body: { ...validBody, amount: 2000 },
      });

      expect(res.statusCode).toBe(422);
      expect(pushes()).toHaveLength(1);
    });

    it("scopes keys to the merchant", async () => {
      const alice = await merchantWithApiKey(app);
      const bob = await merchantWithApiKey(app);

      const a = await pay(alice.authorization, { key: "shared-key" });
      const b = await pay(bob.authorization, { key: "shared-key" });

      expect(a.statusCode).toBe(202);
      expect(b.statusCode).toBe(202);
      expect(a.json().id).not.toBe(b.json().id);
      expect(pushes()).toHaveLength(2);
    });

    it("sends exactly one STK push for identical concurrent requests", async () => {
      const { authorization } = await merchantWithApiKey(app);
      // Slow Daraja down so every request arrives while the first is in flight.
      daraja.on(STK_PUSH_PATH, acceptPushes(300));

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          pay(authorization, { key: "concurrent" }),
        ),
      );

      expect(pushes()).toHaveLength(1);
      const statuses = responses.map((res) => res.statusCode).sort();
      expect(statuses.filter((status) => status === 202)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(9);
      expect(
        responses.find((res) => res.statusCode === 409)!.headers["retry-after"],
      ).toBe("1");

      // Once it finishes, a retry replays the result.
      const retry = await pay(authorization, { key: "concurrent" });
      expect(retry.statusCode).toBe(202);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(pushes()).toHaveLength(1);

      const count = await app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(payments)
        .where(
          eq(payments.checkoutRequestId, retry.json().checkout_request_id),
        );
      expect(count[0]!.n).toBe(1);
    });

    it("marks the payment FAILED with result_desc when Daraja rejects the push", async () => {
      const { authorization } = await merchantWithApiKey(app);
      daraja.on(STK_PUSH_PATH, () => ({
        status: 400,
        body: {
          requestId: "1234-5678",
          errorCode: "400.002.02",
          errorMessage: "Bad Request - Invalid PhoneNumber",
        },
      }));

      const res = await pay(authorization, { key: "rejected" });

      expect(res.statusCode).toBe(502);
      const body = res.json<PaymentBody>();
      expect(body).toMatchObject({
        status: "FAILED",
        checkout_request_id: null,
        result_desc: "Bad Request - Invalid PhoneNumber",
      });
      expect(body.completed_at).not.toBeNull();
      expect(await events(body.id)).toEqual(["created", "stk_push_rejected"]);

      // The failure is the stored result for this key: no second push.
      const retry = await pay(authorization, { key: "rejected" });
      expect(retry.statusCode).toBe(502);
      expect(retry.json().id).toBe(body.id);
      expect(pushes()).toHaveLength(1);
    });

    it("marks the payment FAILED when Daraja answers with a non-zero ResponseCode", async () => {
      const { authorization } = await merchantWithApiKey(app);
      daraja.on(STK_PUSH_PATH, () => ({
        status: 200,
        body: {
          MerchantRequestID: "29115-1",
          CheckoutRequestID: "ws_CO_rejected",
          ResponseCode: "1",
          ResponseDescription: "Rejected",
          CustomerMessage: "Rejected",
        },
      }));

      const res = await pay(authorization);

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        status: "FAILED",
        result_desc: "Rejected",
      });
    });

    it("keeps the payment PENDING, without retrying, when the push outcome is unknown", async () => {
      const { authorization } = await merchantWithApiKey(app);
      daraja.on(STK_PUSH_PATH, () => ({
        status: 503,
        body: "<html>busy</html>",
      }));

      const res = await pay(authorization, { key: "unknown" });

      expect(res.statusCode).toBe(202);
      const body = res.json<PaymentBody>();
      expect(body).toMatchObject({
        status: "PENDING",
        checkout_request_id: null,
      });
      expect(await events(body.id)).toEqual(["created", "stk_push_unknown"]);

      // A retry must not prompt the customer a second time.
      expect((await pay(authorization, { key: "unknown" })).statusCode).toBe(
        202,
      );
      expect(pushes()).toHaveLength(1);
    });
  });

  describe("GET /v1/payments/:id", () => {
    it("returns the merchant's payment", async () => {
      const { authorization } = await merchantWithApiKey(app);
      const created = (await pay(authorization)).json<PaymentBody>();

      const res = await app.inject({
        method: "GET",
        url: `/v1/payments/${created.id}`,
        headers: { authorization },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(created);
    });

    it("never shows another merchant's payment", async () => {
      const alice = await merchantWithApiKey(app);
      const bob = await merchantWithApiKey(app);
      const created = (await pay(alice.authorization)).json<PaymentBody>();

      const res = await app.inject({
        method: "GET",
        url: `/v1/payments/${created.id}`,
        headers: { authorization: bob.authorization },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe("Payment not found");
    });

    it("rejects an id that isn't a UUID", async () => {
      const { authorization } = await merchantWithApiKey(app);
      const res = await app.inject({
        method: "GET",
        url: "/v1/payments/not-a-uuid",
        headers: { authorization },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /v1/payments", () => {
    const list = (authorization: string, query = "") =>
      app.inject({
        method: "GET",
        url: `/v1/payments${query}`,
        headers: { authorization },
      });

    it("pages through the merchant's payments, newest first, without gaps or repeats", async () => {
      const alice = await merchantWithApiKey(app);
      const bob = await merchantWithApiKey(app);
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        created.push((await pay(alice.authorization)).json<PaymentBody>().id);
      }
      await pay(bob.authorization);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await list(
          alice.authorization,
          `?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(res.statusCode).toBe(200);
        const page: Page = res.json();
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data.map((payment) => payment.id));
        cursor = page.next_cursor;
      } while (cursor);

      expect(seen).toEqual([...created].reverse());
    });

    it("pages correctly through payments created in the same millisecond", async () => {
      const { authorization, merchantId } = await merchantWithApiKey(app);
      // Rows that differ only in microseconds, and some that share a timestamp.
      const rows = await app.db
        .insert(payments)
        .values(
          [
            "2026-11-11 09:30:00.000100+00",
            "2026-11-11 09:30:00.000200+00",
            "2026-11-11 09:30:00.000200+00",
            "2026-11-11 09:30:00.000300+00",
          ].map((createdAt) => ({
            merchantId,
            amount: 10,
            phone: "254712345678",
            accountReference: "INV",
            description: "Test",
            status: "PENDING" as const,
            createdAt: sql`${createdAt}::timestamptz`,
          })),
        )
        .returning({ id: payments.id });

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await list(
          authorization,
          `?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page: Page = res.json();
        seen.push(...page.data.map((payment) => payment.id));
        cursor = page.next_cursor;
      } while (cursor);

      expect(seen.sort()).toEqual(rows.map((row) => row.id).sort());
    });

    it("filters by status and creation time", async () => {
      const { authorization } = await merchantWithApiKey(app);
      const pending = (await pay(authorization)).json<PaymentBody>();
      daraja.on(STK_PUSH_PATH, () => ({
        status: 400,
        body: { errorCode: "400.002.02", errorMessage: "Invalid PhoneNumber" },
      }));
      const failed = (await pay(authorization)).json<PaymentBody>();

      const failedOnly = await list(authorization, "?status=FAILED");
      expect(failedOnly.json().data.map((p: PaymentBody) => p.id)).toEqual([
        failed.id,
      ]);

      const future = await list(
        authorization,
        `?created_from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      );
      expect(future.json().data).toEqual([]);

      const past = await list(
        authorization,
        `?created_to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      );
      expect(past.json().data.map((p: PaymentBody) => p.id)).toEqual([
        failed.id,
        pending.id,
      ]);

      expect((await list(authorization, "?status=PAID")).statusCode).toBe(400);
    });

    it("rejects a tampered cursor", async () => {
      const { authorization } = await merchantWithApiKey(app);
      const res = await list(authorization, "?cursor=not-a-real-cursor");
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("cursor");
    });
  });

  describe("idempotency key expiry", () => {
    it("purges keys older than 24 hours and lets an expired key be reused", async () => {
      const { authorization, merchantId } = await merchantWithApiKey(app);
      const first = await pay(authorization, { key: "old-key" });
      expect(first.statusCode).toBe(202);

      // Expire this merchant's key.
      await app.db
        .update(idempotencyKeys)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(eq(idempotencyKeys.merchantId, merchantId));

      // Reusing it after expiry starts a new payment, even before a purge.
      const second = await pay(authorization, {
        key: "old-key",
        body: { ...validBody, amount: 2000 },
      });
      expect(second.statusCode).toBe(202);
      expect(second.json().id).not.toBe(first.json().id);
      expect(pushes()).toHaveLength(2);

      await app.db
        .update(idempotencyKeys)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(eq(idempotencyKeys.merchantId, merchantId));
      expect(await purgeExpiredIdempotencyKeys(app.db)).toBeGreaterThanOrEqual(
        1,
      );
      const left = await app.db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.merchantId, merchantId));
      expect(left).toEqual([]);
    });
  });
});
