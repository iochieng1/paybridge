import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { paymentEvents, payments } from "../src/db/schema.js";
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
const SAFARICOM_IP = "196.201.214.200";

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

/** STK Push Query answers: a final result, or "still processing". */
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

const successCallback = (
  checkoutRequestId: string,
  {
    amount = AMOUNT,
    receipt = `TKB${randomUUID().slice(0, 7).toUpperCase()}`,
  }: { amount?: number; receipt?: string | null } = {},
) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: "29115-1",
      CheckoutRequestID: checkoutRequestId,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: amount },
          ...(receipt === null
            ? []
            : [{ Name: "MpesaReceiptNumber", Value: receipt }]),
          { Name: "TransactionDate", Value: 20261111093512 },
          { Name: "PhoneNumber", Value: 254712345678 },
        ],
      },
    },
  },
});

const failedCallback = (
  checkoutRequestId: string,
  resultCode: number,
  resultDesc = "Request cancelled by user",
) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: "29115-1",
      CheckoutRequestID: checkoutRequestId,
      ResultCode: resultCode,
      ResultDesc: resultDesc,
    },
  },
});

const setup = async (overrides: Partial<Config> = {}) => {
  const daraja = await startFakeDaraja();
  const app = await buildTestApp(overrides, { darajaBaseUrl: daraja.baseUrl });
  return { app, daraja };
};

describe("M-Pesa callbacks", () => {
  let app: App;
  let daraja: FakeDaraja;

  beforeAll(async () => {
    ({ app, daraja } = await setup());
  });

  afterAll(async () => {
    await app.close();
    await daraja.close();
  });

  beforeEach(() => {
    daraja.reset();
    daraja.on(STK_PUSH_PATH, acceptPushes);
  });

  /** Creates a PENDING payment; returns its id, callback token and checkout id. */
  const pendingPayment = async (target = { app, daraja }) => {
    const { authorization } = await merchantWithApiKey(target.app);
    const res = await target.app.inject({
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
    const pushes = target.daraja.to(STK_PUSH_PATH);
    const callbackUrl = new URL(
      (pushes[pushes.length - 1]!.body as { CallBackURL: string }).CallBackURL,
    );
    const body = res.json<{
      id: string;
      checkout_request_id: string | null;
    }>();
    return {
      id: body.id,
      checkoutRequestId: body.checkout_request_id!,
      token: callbackUrl.pathname.split("/").pop()!,
    };
  };

  const deliver = (
    token: string,
    payload: unknown,
    {
      target = app,
      remoteAddress,
    }: { target?: App; remoteAddress?: string } = {},
  ) =>
    target.inject({
      method: "POST",
      url: `/v1/callbacks/mpesa/${token}`,
      payload: payload as object,
      ...(remoteAddress && { remoteAddress }),
    });

  const paymentRow = async (id: string) => {
    const [row] = await app.db
      .select()
      .from(payments)
      .where(eq(payments.id, id));
    return row!;
  };

  const eventTypes = async (id: string) =>
    (
      await app.db
        .select({ type: paymentEvents.type })
        .from(paymentEvents)
        .where(eq(paymentEvents.paymentId, id))
        .orderBy(paymentEvents.id)
    ).map((event) => event.type);

  it("returns 404 for an unknown token", async () => {
    const res = await deliver("not-a-real-token", successCallback("ws_CO_x"));

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Unknown callback");
  });

  it("rejects a malformed callback", async () => {
    const { token, id } = await pendingPayment();

    const res = await deliver(token, { Body: { nope: true } });

    expect(res.statusCode).toBe(400);
    expect((await paymentRow(id)).status).toBe("PENDING");
  });

  it("marks the payment SUCCEEDED with its receipt", async () => {
    const { id, token, checkoutRequestId } = await pendingPayment();

    const res = await deliver(
      token,
      successCallback(checkoutRequestId, { receipt: "TKB4XYZ123" }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    const row = await paymentRow(id);
    expect(row).toMatchObject({
      status: "SUCCEEDED",
      mpesaReceipt: "TKB4XYZ123",
      resultCode: 0,
      resultDesc: "The service request is processed successfully.",
    });
    expect(row.completedAt).not.toBeNull();
    expect(await eventTypes(id)).toEqual([
      "created",
      "stk_push_accepted",
      "callback_applied",
    ]);
    // A trustworthy callback needs no STK Push Query.
    expect(daraja.to(STK_QUERY_PATH)).toHaveLength(0);
  });

  it("applies a success callback replayed 10 times exactly once", async () => {
    const { id, token, checkoutRequestId } = await pendingPayment();
    const callback = successCallback(checkoutRequestId);

    for (let i = 0; i < 10; i++) {
      expect((await deliver(token, callback)).statusCode).toBe(200);
    }

    expect((await paymentRow(id)).status).toBe("SUCCEEDED");
    expect(await eventTypes(id)).toEqual([
      "created",
      "stk_push_accepted",
      "callback_applied",
    ]);
  });

  it("applies 10 concurrent copies of a success callback exactly once", async () => {
    const { id, token, checkoutRequestId } = await pendingPayment();
    const callback = successCallback(checkoutRequestId);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => deliver(token, callback)),
    );

    expect(responses.map((res) => res.statusCode)).toEqual(Array(10).fill(200));
    const applied = (await eventTypes(id)).filter(
      (type) => type === "callback_applied",
    );
    expect(applied).toHaveLength(1);
  });

  it("ignores a late failure callback after success", async () => {
    const { id, token, checkoutRequestId } = await pendingPayment();
    await deliver(
      token,
      successCallback(checkoutRequestId, { receipt: "TKBLATE001" }),
    );

    const res = await deliver(token, failedCallback(checkoutRequestId, 1032));

    expect(res.statusCode).toBe(200);
    expect(await paymentRow(id)).toMatchObject({
      status: "SUCCEEDED",
      mpesaReceipt: "TKBLATE001",
      resultCode: 0,
    });
    expect(await eventTypes(id)).toHaveLength(3);
  });

  it.each([
    [1032, "CANCELLED"],
    [1037, "TIMED_OUT"],
    [1, "FAILED"],
    [2001, "FAILED"],
  ])("maps ResultCode %i to %s", async (resultCode, status) => {
    const { id, token, checkoutRequestId } = await pendingPayment();

    await deliver(
      token,
      failedCallback(checkoutRequestId, resultCode, `Result ${resultCode}`),
    );

    expect(await paymentRow(id)).toMatchObject({
      status,
      resultCode,
      resultDesc: `Result ${resultCode}`,
      mpesaReceipt: null,
    });
  });

  describe("callbacks that don't match the payment", () => {
    it("confirms an amount mismatch with STK Push Query, and never stores its receipt", async () => {
      const { id, token, checkoutRequestId } = await pendingPayment();
      daraja.on(STK_QUERY_PATH, queryResult(0, "Paid, says the query"));

      const res = await deliver(
        token,
        successCallback(checkoutRequestId, {
          amount: 1,
          receipt: "TKBFAKE001",
        }),
      );

      expect(res.statusCode).toBe(200);
      const [query] = daraja.to(STK_QUERY_PATH);
      expect(
        (query!.body as { CheckoutRequestID: string }).CheckoutRequestID,
      ).toBe(checkoutRequestId);
      expect(await paymentRow(id)).toMatchObject({
        status: "SUCCEEDED",
        resultDesc: "Paid, says the query",
        mpesaReceipt: null,
      });
      expect(await eventTypes(id)).toContain("callback_verified_by_query");
    });

    it("uses the query's result when it disagrees with the callback", async () => {
      const { id, token, checkoutRequestId } = await pendingPayment();
      daraja.on(STK_QUERY_PATH, queryResult(1032, "Cancelled by user"));

      await deliver(
        token,
        successCallback(checkoutRequestId, { receipt: null }),
      );

      expect((await paymentRow(id)).status).toBe("CANCELLED");
    });

    it("queries the payment's own checkout id when the callback names another", async () => {
      const { id, token, checkoutRequestId } = await pendingPayment();
      daraja.on(STK_QUERY_PATH, queryResult(1037, "Timed out"));

      await deliver(token, successCallback("ws_CO_someone_elses"));

      const [query] = daraja.to(STK_QUERY_PATH);
      expect(
        (query!.body as { CheckoutRequestID: string }).CheckoutRequestID,
      ).toBe(checkoutRequestId);
      expect(await paymentRow(id)).toMatchObject({
        status: "TIMED_OUT",
        checkoutRequestId,
      });
    });

    it("leaves the payment PENDING if the query says it's still processing", async () => {
      const { id, token, checkoutRequestId } = await pendingPayment();
      daraja.on(STK_QUERY_PATH, queryPending);

      const res = await deliver(
        token,
        successCallback(checkoutRequestId, { amount: 1 }),
      );

      expect(res.statusCode).toBe(200);
      expect((await paymentRow(id)).status).toBe("PENDING");
      expect(await eventTypes(id)).toEqual([
        "created",
        "stk_push_accepted",
        "callback_unverified",
      ]);
    });

    it("answers 503, changing nothing, when the query can't be made", async () => {
      const { id, token, checkoutRequestId } = await pendingPayment();
      daraja.on(STK_QUERY_PATH, () => ({
        status: 500,
        body: { errorCode: "500.003.02", errorMessage: "System busy" },
      }));

      const res = await deliver(
        token,
        successCallback(checkoutRequestId, { amount: 1 }),
      );

      expect(res.statusCode).toBe(503);
      expect((await paymentRow(id)).status).toBe("PENDING");
    });

    it("keeps mpesa_receipt unique across payments", async () => {
      const first = await pendingPayment();
      const second = await pendingPayment();
      daraja.on(STK_QUERY_PATH, queryResult(0));

      await deliver(
        first.token,
        successCallback(first.checkoutRequestId, { receipt: "TKBDUPE001" }),
      );
      const res = await deliver(
        second.token,
        successCallback(second.checkoutRequestId, { receipt: "TKBDUPE001" }),
      );

      expect(res.statusCode).toBe(200);
      expect((await paymentRow(first.id)).mpesaReceipt).toBe("TKBDUPE001");
      // Verified by query instead, and stored without the reused receipt.
      expect(await paymentRow(second.id)).toMatchObject({
        status: "SUCCEEDED",
        mpesaReceipt: null,
      });
      const holders = await app.db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.mpesaReceipt, "TKBDUPE001"));
      expect(holders).toEqual([{ id: first.id }]);
    });

    it("settles a payment whose STK push outcome was unknown", async () => {
      // Daraja's answer to the push was lost, so there's no checkout id yet.
      daraja.on(STK_PUSH_PATH, () => ({ status: 503, body: "busy" }));
      const { id, token } = await pendingPayment();
      expect((await paymentRow(id)).checkoutRequestId).toBeNull();
      daraja.on(STK_QUERY_PATH, queryResult(0));

      await deliver(token, successCallback("ws_CO_from_callback"));

      const [query] = daraja.to(STK_QUERY_PATH);
      expect(
        (query!.body as { CheckoutRequestID: string }).CheckoutRequestID,
      ).toBe("ws_CO_from_callback");
      expect(await paymentRow(id)).toMatchObject({
        status: "SUCCEEDED",
        checkoutRequestId: "ws_CO_from_callback",
        mpesaReceipt: null,
      });
    });

    describe("when Daraja gave two pushes the same CheckoutRequestID", () => {
      /** Two payments; the second couldn't store the shared checkout id. */
      const paymentsSharingCheckoutId = async () => {
        const shared = `ws_CO_${randomUUID()}`;
        let count = 0;
        daraja.on(STK_PUSH_PATH, () => {
          count += 1;
          return {
            status: 200,
            body: {
              MerchantRequestID: `29115-shared-${count}`,
              CheckoutRequestID: shared,
              ResponseCode: "0",
              ResponseDescription: "Success. Request accepted for processing",
              CustomerMessage: "Success. Request accepted for processing",
            },
          };
        });
        const first = await pendingPayment();
        const second = await pendingPayment();
        expect(first.checkoutRequestId).toBe(shared);
        expect((await paymentRow(second.id)).checkoutRequestId).toBeNull();
        return { shared, first, second };
      };

      /** STK Push Query answering for the push with this MerchantRequestID. */
      const queryFor =
        (merchantRequestId: string, resultCode = 0): Handler =>
        (request) => ({
          status: 200,
          body: {
            ResponseCode: "0",
            ResponseDescription: "The service request has been accepted",
            MerchantRequestID: merchantRequestId,
            CheckoutRequestID: (request.body as { CheckoutRequestID: string })
              .CheckoutRequestID,
            ResultCode: String(resultCode),
            ResultDesc: "Result from query",
          },
        });

      it("settles the payment when the query is about its own push", async () => {
        const { shared, first, second } = await paymentsSharingCheckoutId();
        daraja.on(STK_QUERY_PATH, queryFor("29115-shared-2", 1032));

        const res = await deliver(second.token, failedCallback(shared, 1032));

        expect(res.statusCode).toBe(200);
        expect(await paymentRow(second.id)).toMatchObject({
          status: "CANCELLED",
          resultCode: 1032,
          // Still the other payment's, so it isn't stored here.
          checkoutRequestId: null,
        });
        expect((await paymentRow(first.id)).status).toBe("PENDING");
        expect((await eventTypes(second.id)).at(-1)).toBe(
          "callback_verified_by_query",
        );
      });

      it("changes nothing when the query is about the other push", async () => {
        const { shared, first, second } = await paymentsSharingCheckoutId();
        daraja.on(STK_QUERY_PATH, queryFor("29115-shared-1"));

        const res = await deliver(second.token, successCallback(shared));

        // Not a 500 that Daraja would redeliver forever.
        expect(res.statusCode).toBe(200);
        expect(await paymentRow(second.id)).toMatchObject({
          status: "PENDING",
          checkoutRequestId: null,
          mpesaReceipt: null,
        });
        expect((await paymentRow(first.id)).status).toBe("PENDING");
        expect((await eventTypes(second.id)).at(-1)).toBe("callback_ambiguous");

        // A redelivery is acknowledged the same way.
        expect(
          (await deliver(second.token, successCallback(shared))).statusCode,
        ).toBe(200);
      });
    });
  });

  describe("IP allowlist", () => {
    let guarded: { app: App; daraja: FakeDaraja };

    beforeAll(async () => {
      guarded = await setup({ MPESA_CALLBACK_IP_ALLOWLIST: [SAFARICOM_IP] });
      guarded.daraja.on(STK_PUSH_PATH, acceptPushes);
    });

    afterAll(async () => {
      await guarded.app.close();
      await guarded.daraja.close();
    });

    it("rejects callbacks from other IPs and accepts listed ones", async () => {
      const { id, token, checkoutRequestId } = await pendingPayment(guarded);
      const callback = successCallback(checkoutRequestId);

      const blocked = await deliver(token, callback, {
        target: guarded.app,
        remoteAddress: "203.0.113.9",
      });
      expect(blocked.statusCode).toBe(403);
      expect((await paymentRow(id)).status).toBe("PENDING");

      const allowed = await deliver(token, callback, {
        target: guarded.app,
        remoteAddress: SAFARICOM_IP,
      });
      expect(allowed.statusCode).toBe(200);
      expect((await paymentRow(id)).status).toBe("SUCCEEDED");
    });
  });
});

describe("callback logging", () => {
  it("never writes a callback token to the logs", async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const daraja = await startFakeDaraja();
    daraja.on(STK_PUSH_PATH, acceptPushes);
    const app = await buildTestApp(
      { LOG_LEVEL: "info" },
      { darajaBaseUrl: daraja.baseUrl, logStream },
    );
    try {
      const { authorization } = await merchantWithApiKey(app);
      const created = await app.inject({
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
      const { checkout_request_id: checkoutRequestId } = created.json<{
        checkout_request_id: string;
      }>();
      const callbackUrl = new URL(
        (daraja.to(STK_PUSH_PATH).at(-1)!.body as { CallBackURL: string })
          .CallBackURL,
      );
      const token = callbackUrl.pathname.split("/").pop()!;

      const res = await app.inject({
        method: "POST",
        url: `/v1/callbacks/mpesa/${token}?attempt=1`,
        payload: successCallback(checkoutRequestId),
      });
      expect(res.statusCode).toBe(200);

      const logs = lines.join("");
      expect(logs).not.toContain(token);
      // The request is still logged, just without its token.
      expect(logs).toContain("/v1/callbacks/mpesa/[REDACTED]?attempt=1");
    } finally {
      await app.close();
      await daraja.close();
    }
  });
});
