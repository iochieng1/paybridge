import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import {
  paymentEvents,
  payments,
  webhookDeliveries,
  webhookEndpoints,
} from "../src/db/schema.js";
import { deliverPaymentWebhook } from "../src/webhooks/deliver.js";
import { verifySignature } from "../src/webhooks/signature.js";
import {
  type Handler,
  startFakeDaraja,
  STK_PUSH_PATH,
  STK_QUERY_PATH,
} from "./fake-daraja.js";
import { buildTestApp, merchantWithApiKey } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type FakeDaraja = Awaited<ReturnType<typeof startFakeDaraja>>;

const AMOUNT = 1500;
const RETRY_DELAYS_MS = [50, 50, 50, 50, 50];

const acceptPushes: Handler = () => ({
  status: 200,
  body: {
    MerchantRequestID: `29115-${randomUUID()}`,
    CheckoutRequestID: `ws_CO_${randomUUID()}`,
    ResponseCode: "0",
    ResponseDescription: "Success. Request accepted for processing",
    CustomerMessage: "Success. Request accepted for processing",
  },
});

const queryResult =
  (resultCode: number, resultDesc = "Result from query"): Handler =>
  (request) => ({
    status: 200,
    body: {
      ResponseCode: "0",
      ResponseDescription:
        "The service request has been accepted successsfully",
      MerchantRequestID: "29115-1",
      CheckoutRequestID: (request.body as { CheckoutRequestID: string })
        .CheckoutRequestID,
      ResultCode: String(resultCode),
      ResultDesc: resultDesc,
    },
  });

const queryPending: Handler = () => ({
  status: 500,
  body: {
    requestId: "1234",
    errorCode: "500.001.1001",
    errorMessage: "The transaction is being processed",
  },
});

const successCallback = (checkoutRequestId: string) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: "29115-1",
      CheckoutRequestID: checkoutRequestId,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: AMOUNT },
          {
            Name: "MpesaReceiptNumber",
            Value: `TKB${randomUUID().slice(0, 7).toUpperCase()}`,
          },
        ],
      },
    },
  },
});

type Received = {
  path: string;
  headers: Record<string, unknown>;
  body: string;
};
type ReceiverReply = number | "hang";

/** A merchant's webhook receiver on 127.0.0.1 with scripted answers per path. */
const startReceiver = async () => {
  const received: Received[] = [];
  const scripts = new Map<string, ReceiverReply[]>();
  const hanging = new Set<ServerResponse>();

  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url!, headers: req.headers, body });
    const reply = scripts.get(req.url!)?.shift() ?? 200;
    if (reply === "hang") {
      hanging.add(res);
      return;
    }
    res.writeHead(reply).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    received,
    /** Answers for the next requests to `path`; 200 once they run out. */
    script: (path: string, replies: ReceiverReply[]) =>
      scripts.set(path, replies),
    to: (path: string) => received.filter((request) => request.path === path),
    close: async () => {
      for (const res of hanging) res.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const waitFor = async (
  check: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("webhooks", () => {
  let app: App;
  let daraja: FakeDaraja;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  beforeAll(async () => {
    daraja = await startFakeDaraja();
    receiver = await startReceiver();
    app = await buildTestApp(
      { RUN_WORKERS: true },
      {
        darajaBaseUrl: daraja.baseUrl,
        webhookRetryDelaysMs: RETRY_DELAYS_MS,
        webhookTimeoutMs: 300,
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await daraja.close();
    await receiver.close();
  });

  beforeEach(() => {
    daraja.reset();
    daraja.on(STK_PUSH_PATH, acceptPushes);
  });

  /** A merchant with an API key and (optionally) a webhook endpoint at `path`. */
  const merchant = async (path?: string) => {
    const credentials = await merchantWithApiKey(app);
    let secret: string | undefined;
    if (path) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/webhook-endpoint",
        headers: { authorization: `Bearer ${credentials.accessToken}` },
        payload: { url: `${receiver.baseUrl}${path}` },
      });
      expect(res.statusCode).toBe(200);
      secret = res.json<{ secret: string }>().secret;
    }
    return { ...credentials, secret: secret! };
  };

  const pendingPayment = async (authorization: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { authorization, "idempotency-key": randomUUID() },
      payload: {
        phone: "0712345678",
        amount: AMOUNT,
        reference: "INV-1",
        description: "Order 1",
      },
    });
    const pushes = daraja.to(STK_PUSH_PATH);
    const callbackUrl = new URL(
      (pushes.at(-1)!.body as { CallBackURL: string }).CallBackURL,
    );
    const body = res.json<{ id: string; checkout_request_id: string }>();
    return {
      id: body.id,
      checkoutRequestId: body.checkout_request_id,
      token: callbackUrl.pathname.split("/").pop()!,
    };
  };

  const settle = (token: string, checkoutRequestId: string) =>
    app.inject({
      method: "POST",
      url: `/v1/callbacks/mpesa/${token}`,
      payload: successCallback(checkoutRequestId),
    });

  const deliveries = (paymentId: string) =>
    app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.paymentId, paymentId))
      .orderBy(webhookDeliveries.attempt);

  describe("PUT /v1/webhook-endpoint", () => {
    it("returns the secret once and stores it encrypted", async () => {
      const { accessToken, merchantId, secret } = await merchant("/setup");

      expect(secret).toMatch(/^whsec_/);
      const [row] = await app.db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.merchantId, merchantId));
      expect(row!.secretEncrypted).not.toContain(secret.slice(6));

      const get = await app.inject({
        method: "GET",
        url: "/v1/webhook-endpoint",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({
        url: `${receiver.baseUrl}/setup`,
        created_at: expect.any(String),
      });
      expect(get.body).not.toContain("whsec_");
    });

    it("rotates the secret when set again, and can be removed", async () => {
      const { accessToken, secret } = await merchant("/one");
      const headers = { authorization: `Bearer ${accessToken}` };

      const again = await app.inject({
        method: "PUT",
        url: "/v1/webhook-endpoint",
        headers,
        payload: { url: `${receiver.baseUrl}/two` },
      });
      expect(again.json()).toMatchObject({ url: `${receiver.baseUrl}/two` });
      expect(again.json<{ secret: string }>().secret).not.toBe(secret);

      const removed = await app.inject({
        method: "DELETE",
        url: "/v1/webhook-endpoint",
        headers,
      });
      expect(removed.statusCode).toBe(204);
      const get = await app.inject({
        method: "GET",
        url: "/v1/webhook-endpoint",
        headers,
      });
      expect(get.statusCode).toBe(404);
    });

    it("needs an access token, not an API key", async () => {
      const { authorization } = await merchant();
      for (const headers of [{}, { authorization }]) {
        const res = await app.inject({
          method: "PUT",
          url: "/v1/webhook-endpoint",
          headers,
          payload: { url: "https://example.com/hook" },
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("rejects private and non-http URLs when private URLs aren't allowed", async () => {
      const strict = await buildTestApp({ WEBHOOK_ALLOW_PRIVATE_URLS: false });
      try {
        const { accessToken } = await merchantWithApiKey(strict);
        for (const url of [
          "http://localhost:3000/hook",
          "http://127.0.0.1/hook",
          "http://169.254.169.254/latest/meta-data",
          "http://[::1]/hook",
          "ftp://example.com/hook",
          "https://user:pass@example.com/hook",
        ]) {
          const res = await strict.inject({
            method: "PUT",
            url: "/v1/webhook-endpoint",
            headers: { authorization: `Bearer ${accessToken}` },
            payload: { url },
          });
          expect(res.statusCode, url).toBe(422);
        }
      } finally {
        await strict.close();
      }
    });
  });

  describe("delivery", () => {
    it("sends a signed webhook when a payment succeeds", async () => {
      const { authorization, secret } = await merchant("/ok");
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);

      expect((await settle(token, checkoutRequestId)).statusCode).toBe(200);
      await waitFor(() => receiver.to("/ok").length === 1);

      const request = receiver.to("/ok")[0]!;
      expect(
        verifySignature(
          secret,
          request.headers["x-paybridge-signature"] as string,
          request.body,
        ),
      ).toMatchObject({ valid: true });
      expect(request.headers["x-paybridge-event-id"]).toBe(`evt_${id}`);
      expect(JSON.parse(request.body)).toMatchObject({
        id: `evt_${id}`,
        type: "payment.succeeded",
        data: { id, status: "SUCCEEDED", amount: AMOUNT },
      });

      await waitFor(async () => (await deliveries(id)).length === 1);
      expect((await deliveries(id))[0]).toMatchObject({
        attempt: 1,
        statusCode: 200,
        error: null,
        nextRetryAt: null,
      });
      expect((await deliveries(id))[0]!.deliveredAt).not.toBeNull();
    });

    it("sends payment.failed when M-Pesa rejects the push", async () => {
      const { authorization } = await merchant("/rejected");
      daraja.on(STK_PUSH_PATH, () => ({
        status: 400,
        body: { errorCode: "400.002.02", errorMessage: "Invalid PhoneNumber" },
      }));

      const res = await app.inject({
        method: "POST",
        url: "/v1/payments",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          phone: "0712345678",
          amount: AMOUNT,
          reference: "R",
          description: "D",
        },
      });
      expect(res.statusCode).toBe(502);

      await waitFor(() => receiver.to("/rejected").length === 1);
      expect(JSON.parse(receiver.to("/rejected")[0]!.body)).toMatchObject({
        type: "payment.failed",
      });
    });

    it("retries 5xx and timeouts with backoff, logs every attempt, and stops on 2xx", async () => {
      const { authorization } = await merchant("/flaky");
      receiver.script("/flaky", [500, "hang", 503, 200]);
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);

      await settle(token, checkoutRequestId);
      await waitFor(async () => (await deliveries(id)).length === 4);

      const rows = await deliveries(id);
      expect(
        rows.map((row) => [row.attempt, row.statusCode, row.error]),
      ).toEqual([
        [1, 500, "HTTP 500"],
        [2, null, "Timed out after 300 ms"],
        [3, 503, "HTTP 503"],
        [4, 200, null],
      ]);
      expect(rows.slice(0, 3).every((row) => row.nextRetryAt !== null)).toBe(
        true,
      );
      expect(rows[3]!.deliveredAt).not.toBeNull();
      expect(rows[3]!.nextRetryAt).toBeNull();

      // Delivered: nothing more is sent.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(receiver.to("/flaky")).toHaveLength(4);
      expect(await deliveries(id)).toHaveLength(4);
    });

    it("gives up after six attempts", async () => {
      const { authorization } = await merchant("/down");
      receiver.script("/down", Array(10).fill(500));
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);

      await settle(token, checkoutRequestId);
      await waitFor(async () => (await deliveries(id)).length === 6);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const rows = await deliveries(id);
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.deliveredAt === null)).toBe(true);
      // The last attempt has no retry scheduled.
      expect(rows[5]!.nextRetryAt).toBeNull();
      const job = await app.jobs.webhookQueue.getJob(`payment-${id}`);
      expect(await job!.getState()).toBe("failed");
    });

    it("lists the attempts for the merchant, and only for its own payments", async () => {
      const { authorization } = await merchant("/listed");
      receiver.script("/listed", [502]);
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);
      await settle(token, checkoutRequestId);
      await waitFor(async () => (await deliveries(id)).length === 2);

      const res = await app.inject({
        method: "GET",
        url: `/v1/payments/${id}/webhook-deliveries`,
        headers: { authorization },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: unknown[] }>().data).toEqual([
        expect.objectContaining({
          attempt: 1,
          status_code: 502,
          delivered_at: null,
        }),
        expect.objectContaining({
          attempt: 2,
          status_code: 200,
          next_retry_at: null,
        }),
      ]);

      const other = await merchant();
      const forbidden = await app.inject({
        method: "GET",
        url: `/v1/payments/${id}/webhook-deliveries`,
        headers: { authorization: other.authorization },
      });
      expect(forbidden.statusCode).toBe(404);
    });

    it("sends nothing to a merchant without an endpoint", async () => {
      const { authorization } = await merchant();
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);

      await settle(token, checkoutRequestId);
      const job = await app.jobs.webhookQueue.getJob(`payment-${id}`);
      await waitFor(async () => (await job!.getState()) === "completed");
      expect(await deliveries(id)).toHaveLength(0);
    });
  });

  describe("idempotency", () => {
    it("queues one job however many times a payment is queued", async () => {
      const { authorization } = await merchant("/once");
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);
      await settle(token, checkoutRequestId);

      await Promise.all(
        Array.from({ length: 5 }, () => app.jobs.enqueueWebhook({ id })),
      );
      await waitFor(() => receiver.to("/once").length === 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(receiver.to("/once")).toHaveLength(1);
    });

    it("doesn't send again when a job re-runs after its delivery was logged", async () => {
      // Simulates a worker that crashed after logging the 2xx but before
      // BullMQ marked the job complete: the job runs again.
      const { authorization } = await merchant("/rerun");
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);
      await settle(token, checkoutRequestId);
      await waitFor(async () => (await deliveries(id)).length === 1);

      const outcome = await deliverPaymentWebhook(
        {
          db: app.db,
          encryptionKey: app.webhookEncryptionKey,
          allowPrivateAddresses: true,
        },
        id,
        2,
        undefined,
      );

      expect(outcome).toEqual({ kind: "skipped", reason: "already delivered" });
      expect(receiver.to("/rerun")).toHaveLength(1);
      expect(await deliveries(id)).toHaveLength(1);
    });

    it("sweeps up a final payment whose webhook was never queued", async () => {
      const { authorization } = await merchant("/swept");
      const { id } = await pendingPayment(authorization);
      // Settled without going through a route, as if the process died
      // right after the transaction committed.
      await app.db
        .update(payments)
        .set({ status: "SUCCEEDED", completedAt: new Date() })
        .where(eq(payments.id, id));

      expect(await app.jobs.sweepMissedWebhooks()).toBeGreaterThanOrEqual(1);
      await waitFor(() => receiver.to("/swept").length === 1);
    });
  });

  describe("reconciliation", () => {
    const backdate = (id: string, seconds: number) =>
      app.db
        .update(payments)
        .set({ updatedAt: new Date(Date.now() - seconds * 1000) })
        .where(eq(payments.id, id));

    const paymentRow = async (id: string) =>
      (await app.db.select().from(payments).where(eq(payments.id, id)))[0]!;

    const eventTypes = async (id: string) =>
      (
        await app.db
          .select({ type: paymentEvents.type })
          .from(paymentEvents)
          .where(eq(paymentEvents.paymentId, id))
          .orderBy(paymentEvents.id)
      ).map((event) => event.type);

    it("settles a payment whose callback never arrived, and sends its webhook", async () => {
      const { authorization } = await merchant("/reconciled");
      const { id, checkoutRequestId } = await pendingPayment(authorization);
      await backdate(id, 180);
      daraja.on(
        STK_QUERY_PATH,
        queryResult(0, "The service request is processed successfully."),
      );

      const { reconciled } = await app.jobs.runMaintenance();

      expect(reconciled.settled).toBeGreaterThanOrEqual(1);
      expect(
        daraja
          .to(STK_QUERY_PATH)
          .some(
            (request) =>
              (request.body as { CheckoutRequestID: string })
                .CheckoutRequestID === checkoutRequestId,
          ),
      ).toBe(true);
      expect(await paymentRow(id)).toMatchObject({
        status: "SUCCEEDED",
        resultCode: 0,
      });
      expect(await eventTypes(id)).toEqual([
        "created",
        "stk_push_accepted",
        "reconciled",
      ]);
      await waitFor(() => receiver.to("/reconciled").length === 1);
    });

    it.each([
      [1032, "CANCELLED"],
      [1037, "TIMED_OUT"],
      [2001, "FAILED"],
    ] as const)("maps query result %i to %s", async (resultCode, status) => {
      const { authorization } = await merchant();
      const { id } = await pendingPayment(authorization);
      await backdate(id, 180);
      daraja.on(STK_QUERY_PATH, queryResult(resultCode));

      await app.jobs.runMaintenance();

      expect((await paymentRow(id)).status).toBe(status);
    });

    it("leaves fresh payments alone", async () => {
      const { authorization } = await merchant();
      const { id, checkoutRequestId } = await pendingPayment(authorization);
      daraja.on(STK_QUERY_PATH, queryResult(0));

      await app.jobs.runMaintenance();

      expect((await paymentRow(id)).status).toBe("PENDING");
      expect(
        daraja
          .to(STK_QUERY_PATH)
          .map(
            (request) =>
              (request.body as { CheckoutRequestID: string }).CheckoutRequestID,
          ),
      ).not.toContain(checkoutRequestId);
    });

    it("keeps a payment PENDING while Daraja says it's processing, and moves it to the back", async () => {
      const { authorization } = await merchant();
      const { id } = await pendingPayment(authorization);
      await backdate(id, 180);
      const before = (await paymentRow(id)).updatedAt;
      daraja.on(STK_QUERY_PATH, queryPending);

      await app.jobs.runMaintenance();

      const row = await paymentRow(id);
      expect(row.status).toBe("PENDING");
      expect(row.updatedAt.getTime()).toBeGreaterThan(before.getTime());
      expect(await eventTypes(id)).toEqual(["created", "stk_push_accepted"]);
    });

    it("is idempotent: running twice, or racing a late callback, settles once", async () => {
      const { authorization } = await merchant();
      const { id, token, checkoutRequestId } =
        await pendingPayment(authorization);
      await backdate(id, 180);
      daraja.on(STK_QUERY_PATH, queryResult(0));

      await Promise.all([
        app.jobs.runMaintenance(),
        app.jobs.runMaintenance(),
        settle(token, checkoutRequestId),
      ]);
      await app.jobs.runMaintenance();

      const settled = (await eventTypes(id)).filter(
        (type) => type === "reconciled" || type === "callback_applied",
      );
      expect(settled).toHaveLength(1);
      expect((await paymentRow(id)).status).toBe("SUCCEEDED");
    });

    it("doesn't query a payment that has no checkout id", async () => {
      const { authorization } = await merchant();
      daraja.on(STK_PUSH_PATH, () => "hang");
      // The push times out, so the outcome is unknown and there's no checkout id.
      const res = await app.inject({
        method: "POST",
        url: "/v1/payments",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          phone: "0712345678",
          amount: AMOUNT,
          reference: "R",
          description: "D",
        },
      });
      const { id } = res.json<{ id: string }>();
      await backdate(id, 180);
      daraja.on(STK_QUERY_PATH, queryResult(0));

      await app.jobs.runMaintenance();

      expect((await paymentRow(id)).status).toBe("PENDING");
    }, 30_000);
  });
});
