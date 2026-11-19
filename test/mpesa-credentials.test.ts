import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { mpesaCredentials, payments } from "../src/db/schema.js";
import {
  type Handler,
  OAUTH_PATH,
  type RecordedRequest,
  startFakeDaraja,
  STK_PUSH_PATH,
  STK_QUERY_PATH,
} from "./fake-daraja.js";
import { buildTestApp, merchantWithApiKey } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type FakeDaraja = Awaited<ReturnType<typeof startFakeDaraja>>;

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
  (resultCode: number): Handler =>
  (request) => ({
    status: 200,
    body: {
      ResponseCode: "0",
      ResponseDescription: "The service request has been accepted",
      MerchantRequestID: "29115-1",
      CheckoutRequestID: (request.body as { CheckoutRequestID: string })
        .CheckoutRequestID,
      ResultCode: String(resultCode),
      ResultDesc: "Result from query",
    },
  });

/** Credentials unique to one test, so no OAuth token is shared via Redis. */
const paybill = (shortcode = "600111") => ({
  shortcode,
  type: "paybill" as const,
  consumer_key: `ck-${randomUUID()}`,
  consumer_secret: `cs-${randomUUID()}`,
  passkey: `pk-${randomUUID()}`,
});

const till = () => ({
  shortcode: "700222",
  type: "till" as const,
  till_number: "5123456",
  consumer_key: `ck-${randomUUID()}`,
  consumer_secret: `cs-${randomUUID()}`,
  passkey: `pk-${randomUUID()}`,
});

type Credentials = ReturnType<typeof paybill> | ReturnType<typeof till>;

type PushBody = {
  BusinessShortCode: string;
  Password: string;
  TransactionType: string;
  PartyB: string;
};

const basicAuth = (key: string, secret: string) =>
  `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;

/** What a push's Password was made from: shortcode + passkey + timestamp. */
const passwordSource = (push: RecordedRequest) =>
  Buffer.from((push.body as PushBody).Password, "base64").toString();

describe("M-Pesa credentials", () => {
  let app: App;
  let daraja: FakeDaraja;

  beforeAll(async () => {
    daraja = await startFakeDaraja();
    app = await buildTestApp({}, { darajaBaseUrl: daraja.baseUrl });
  });

  afterAll(async () => {
    await app.close();
    await daraja.close();
  });

  beforeEach(() => {
    daraja.reset();
    daraja.on(STK_PUSH_PATH, acceptPushes);
  });

  const connect = (
    target: App,
    accessToken: string,
    credentials: Record<string, unknown>,
  ) =>
    target.inject({
      method: "PUT",
      url: "/v1/mpesa-credentials",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: credentials,
    });

  const pay = (target: App, authorization: string) =>
    target.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { authorization, "idempotency-key": randomUUID() },
      payload: {
        phone: "0712345678",
        amount: 100,
        reference: "INV-1",
        description: "Order 1",
      },
    });

  /** A merchant with credentials connected. */
  const connectedMerchant = async (credentials: Credentials = paybill()) => {
    const merchant = await merchantWithApiKey(app);
    const res = await connect(app, merchant.accessToken, credentials);
    expect(res.statusCode).toBe(200);
    return { ...merchant, credentials };
  };

  describe("PUT /v1/mpesa-credentials", () => {
    it("checks the key and secret with Daraja, then shows only a masked key", async () => {
      const { accessToken } = await merchantWithApiKey(app);
      const credentials = paybill();

      const res = await connect(app, accessToken, credentials);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        shortcode: "600111",
        type: "paybill",
        till_number: null,
        consumer_key: `••••${credentials.consumer_key.slice(-4)}`,
      });
      const [oauth] = daraja.to(OAUTH_PATH);
      expect(oauth!.headers.authorization).toBe(
        basicAuth(credentials.consumer_key, credentials.consumer_secret),
      );

      const got = await app.inject({
        method: "GET",
        url: "/v1/mpesa-credentials",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(got.json()).toEqual(res.json());
      for (const body of [res.body, got.body]) {
        expect(body).not.toContain(credentials.consumer_key);
        expect(body).not.toContain(credentials.consumer_secret);
        expect(body).not.toContain(credentials.passkey);
      }
    });

    it("stores no secret in plaintext", async () => {
      const { merchantId, credentials } = await connectedMerchant();

      const rows = await app.db.execute(
        sql`select * from mpesa_credentials where merchant_id = ${merchantId}`,
      );

      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(credentials.consumer_key);
      expect(dump).not.toContain(credentials.consumer_secret);
      expect(dump).not.toContain(credentials.passkey);
    });

    it("rejects a key and secret Daraja doesn't accept, and saves nothing", async () => {
      const { accessToken, merchantId } = await merchantWithApiKey(app);
      daraja.on(OAUTH_PATH, () => ({
        status: 400,
        body: {
          requestId: "1",
          errorCode: "400.008.01",
          errorMessage: "Invalid Authentication passed",
        },
      }));

      const res = await connect(app, accessToken, paybill());

      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe(
        "Daraja rejected this consumer key and secret: Invalid Authentication passed",
      );
      const rows = await app.db
        .select()
        .from(mpesaCredentials)
        .where(eq(mpesaCredentials.merchantId, merchantId));
      expect(rows).toEqual([]);
    });

    it("answers 502 when Daraja can't be reached to check them", async () => {
      const { accessToken } = await merchantWithApiKey(app);
      daraja.on(OAUTH_PATH, () => ({ status: 503, body: "busy" }));

      const res = await connect(app, accessToken, paybill());

      expect(res.statusCode).toBe(502);
    });

    it("needs a till number for a till, and only for a till", async () => {
      const { accessToken } = await merchantWithApiKey(app);

      const noTill = await connect(app, accessToken, {
        ...till(),
        till_number: undefined,
      });
      const paybillWithTill = await connect(app, accessToken, {
        ...paybill(),
        till_number: "5123456",
      });

      expect(noTill.statusCode).toBe(400);
      expect(paybillWithTill.statusCode).toBe(400);
      expect(daraja.to(OAUTH_PATH)).toHaveLength(0);
    });

    it("needs an access token, not an API key", async () => {
      const { authorization } = await merchantWithApiKey(app);

      const res = await app.inject({
        method: "PUT",
        url: "/v1/mpesa-credentials",
        headers: { authorization },
        payload: paybill(),
      });

      expect(res.statusCode).toBe(401);
    });
  });

  it("sends each merchant's payments to its own shortcode, at the same time", async () => {
    const shop = await connectedMerchant(paybill("600111"));
    const kiosk = await connectedMerchant(till());
    daraja.reset();
    daraja.on(STK_PUSH_PATH, acceptPushes);

    const results = await Promise.all([
      pay(app, shop.authorization),
      pay(app, kiosk.authorization),
      pay(app, shop.authorization),
      pay(app, kiosk.authorization),
    ]);
    expect(results.map((res) => res.statusCode)).toEqual([202, 202, 202, 202]);

    const pushes = daraja.to(STK_PUSH_PATH);
    expect(pushes).toHaveLength(4);
    const toShop = pushes.filter(
      (push) => (push.body as PushBody).BusinessShortCode === "600111",
    );
    const toKiosk = pushes.filter(
      (push) => (push.body as PushBody).BusinessShortCode === "700222",
    );
    expect(toShop).toHaveLength(2);
    expect(toKiosk).toHaveLength(2);
    for (const push of toShop) {
      expect(push.body).toMatchObject({
        TransactionType: "CustomerPayBillOnline",
        PartyB: "600111",
      });
      expect(passwordSource(push)).toMatch(
        new RegExp(`^600111${shop.credentials.passkey}\\d{14}$`),
      );
    }
    for (const push of toKiosk) {
      expect(push.body).toMatchObject({
        TransactionType: "CustomerBuyGoodsOnline",
        PartyB: "5123456",
      });
      expect(passwordSource(push)).toMatch(
        new RegExp(`^700222${kiosk.credentials.passkey}\\d{14}$`),
      );
    }
    // Each merchant's Daraja app got its own OAuth token.
    const tokensUsed = (list: RecordedRequest[]) =>
      new Set(list.map((push) => push.headers.authorization));
    const shopTokens = tokensUsed(toShop);
    const kioskTokens = tokensUsed(toKiosk);
    expect([...shopTokens].some((token) => kioskTokens.has(token))).toBe(false);
  });

  it("records which credentials each payment used", async () => {
    const { authorization, merchantId } = await connectedMerchant();

    const res = await pay(app, authorization);

    const [active] = await app.db
      .select({ id: mpesaCredentials.id })
      .from(mpesaCredentials)
      .where(eq(mpesaCredentials.merchantId, merchantId));
    const [row] = await app.db
      .select({ credentialsId: payments.mpesaCredentialsId })
      .from(payments)
      .where(eq(payments.id, res.json<{ id: string }>().id));
    expect(row!.credentialsId).toBe(active!.id);
  });

  describe("replacing credentials", () => {
    it("sends new payments with the new ones, and reconciles open payments with the old ones", async () => {
      const merchant = await connectedMerchant(paybill("600111"));
      const open = (await pay(app, merchant.authorization)).json<{
        id: string;
        checkout_request_id: string;
      }>();

      const replaced = await connect(
        app,
        merchant.accessToken,
        paybill("600999"),
      );
      expect(replaced.statusCode).toBe(200);
      await pay(app, merchant.authorization);
      expect(
        (daraja.to(STK_PUSH_PATH).at(-1)!.body as PushBody).BusinessShortCode,
      ).toBe("600999");

      // The open payment's callback never came: reconciliation asks Daraja
      // with the shortcode it was sent to.
      await app.db
        .update(payments)
        .set({ updatedAt: new Date(Date.now() - 180_000) })
        .where(eq(payments.id, open.id));
      daraja.on(STK_QUERY_PATH, queryResult(0));

      await app.jobs.runMaintenance();

      const query = daraja
        .to(STK_QUERY_PATH)
        .find(
          (request) =>
            (request.body as { CheckoutRequestID: string })
              .CheckoutRequestID === open.checkout_request_id,
        );
      expect(query!.body).toMatchObject({ BusinessShortCode: "600111" });
      expect(passwordSource(query!)).toMatch(
        new RegExp(`^600111${merchant.credentials.passkey}\\d{14}$`),
      );
      const [row] = await app.db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, open.id));
      expect(row!.status).toBe("SUCCEEDED");
    });

    it("checks a suspicious callback with the payment's own credentials", async () => {
      const merchant = await connectedMerchant(paybill("600111"));
      const open = (await pay(app, merchant.authorization)).json<{
        id: string;
      }>();
      const callbackUrl = new URL(
        (daraja.to(STK_PUSH_PATH).at(-1)!.body as { CallBackURL: string })
          .CallBackURL,
      );
      await connect(app, merchant.accessToken, paybill("600999"));
      daraja.on(STK_QUERY_PATH, queryResult(1032));

      // The CheckoutRequestID doesn't match, so it must be checked.
      const res = await app.inject({
        method: "POST",
        url: callbackUrl.pathname,
        payload: {
          Body: {
            stkCallback: {
              MerchantRequestID: "29115-1",
              CheckoutRequestID: "ws_CO_not_this_one",
              ResultCode: 1032,
              ResultDesc: "Request cancelled by user",
            },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(daraja.to(STK_QUERY_PATH)[0]!.body).toMatchObject({
        BusinessShortCode: "600111",
      });
      const [row] = await app.db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, open.id));
      expect(row!.status).toBe("CANCELLED");
    });
  });

  describe("DELETE /v1/mpesa-credentials", () => {
    it("disconnects them; the sandbox then falls back to PayBridge's test shortcode", async () => {
      const merchant = await connectedMerchant();

      const removed = await app.inject({
        method: "DELETE",
        url: "/v1/mpesa-credentials",
        headers: { authorization: `Bearer ${merchant.accessToken}` },
      });
      const got = await app.inject({
        method: "GET",
        url: "/v1/mpesa-credentials",
        headers: { authorization: `Bearer ${merchant.accessToken}` },
      });
      await pay(app, merchant.authorization);

      expect(removed.statusCode).toBe(204);
      expect(got.statusCode).toBe(404);
      expect(
        (daraja.to(STK_PUSH_PATH).at(-1)!.body as PushBody).BusinessShortCode,
      ).toBe("174379");

      const again = await app.inject({
        method: "DELETE",
        url: "/v1/mpesa-credentials",
        headers: { authorization: `Bearer ${merchant.accessToken}` },
      });
      expect(again.statusCode).toBe(404);
    });
  });

  describe("in production", () => {
    let live: App;

    beforeAll(async () => {
      live = await buildTestApp(
        { MPESA_ENV: "production" },
        { darajaBaseUrl: daraja.baseUrl },
      );
    });

    afterAll(async () => {
      await live.close();
    });

    it("refuses payments until the merchant connects its own shortcode", async () => {
      const merchant = await merchantWithApiKey(live);

      const refused = await pay(live, merchant.authorization);

      expect(refused.statusCode).toBe(422);
      expect(refused.json().message).toMatch(/PUT \/v1\/mpesa-credentials/);
      expect(daraja.to(STK_PUSH_PATH)).toHaveLength(0);

      await connect(live, merchant.accessToken, paybill("600111"));
      const accepted = await pay(live, merchant.authorization);
      expect(accepted.statusCode).toBe(202);
      expect(
        (daraja.to(STK_PUSH_PATH).at(-1)!.body as PushBody).BusinessShortCode,
      ).toBe("600111");
    });
  });
});
