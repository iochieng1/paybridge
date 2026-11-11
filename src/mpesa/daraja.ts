import { createHash } from "node:crypto";

import type { Redis } from "ioredis";
import { z } from "zod";

import { normalizePhone } from "./phone.js";

export const DARAJA_BASE_URLS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

/** Refresh the OAuth token this long before Daraja says it expires. */
export const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/** Daraja's STK Push Query answer while the customer hasn't finished yet. */
const STILL_PROCESSING_ERROR_CODE = "500.001.1001";

export type DarajaClientOptions = {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  /** Daraja origin; defaults to the sandbox. Tests point it at a fake server. */
  baseUrl?: string;
  /** Caches the OAuth token so every instance shares one. */
  redis: Redis;
  /** Namespace for the token cache key. */
  cachePrefix?: string;
  /** Per-request timeout for calls to Daraja. */
  timeoutMs?: number;
  /** Clock, for tests. */
  now?: () => Date;
};

export type StkPushRequest = {
  /** Whole shillings, at least 1. */
  amount: number;
  /** Any common Kenyan format; normalised to 2547XXXXXXXX / 2541XXXXXXXX. */
  phone: string;
  /** Shown to the customer as the account number. Daraja allows 12 chars. */
  accountReference: string;
  /** Daraja allows 13 chars. */
  description: string;
  /** Public HTTPS URL Daraja posts the result to. */
  callbackUrl: string;
};

export type StkPushResult = {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseDescription: string;
  customerMessage: string;
};

export type StkQueryResult =
  | { status: "pending" }
  | {
      status: "completed";
      /** 0 = paid. Anything else failed, e.g. 1032 = cancelled by the customer. */
      resultCode: number;
      resultDesc: string;
      merchantRequestId: string;
      checkoutRequestId: string;
    };

/** A failed call to Daraja: HTTP error, Daraja error code, bad JSON or timeout. */
export class DarajaError extends Error {
  override name = "DarajaError";

  constructor(
    message: string,
    readonly details: {
      /** HTTP status, if Daraja responded. */
      status?: number;
      /** Daraja's errorCode (e.g. 400.002.02) or ResponseCode. */
      code?: string;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: details.cause });
  }
}

/**
 * Timestamp in YYYYMMDDHHmmss, Africa/Nairobi time (UTC+3, no DST), as
 * Daraja requires for the STK password.
 */
export const mpesaTimestamp = (date: Date = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
};

/** STK password: base64(shortcode + passkey + timestamp). */
export const stkPassword = (
  shortcode: string,
  passkey: string,
  timestamp: string,
) => Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

const tokenResponse = z.object({
  access_token: z.string().min(1),
  // Daraja sends this as a string ("3599").
  expires_in: z.coerce.number().int().positive(),
});

const errorResponse = z.object({
  requestId: z.string().optional(),
  errorCode: z.string(),
  errorMessage: z.string(),
});

const stkPushResponse = z.object({
  MerchantRequestID: z.string(),
  CheckoutRequestID: z.string(),
  ResponseCode: z.string(),
  ResponseDescription: z.string(),
  CustomerMessage: z.string(),
});

const stkQueryResponse = z.object({
  ResponseCode: z.string(),
  ResponseDescription: z.string(),
  MerchantRequestID: z.string(),
  CheckoutRequestID: z.string(),
  ResultCode: z.coerce.number().int(),
  ResultDesc: z.string(),
});

const stkPushRequest = z.object({
  amount: z.number().int().min(1),
  phone: z.string(),
  accountReference: z.string().min(1).max(12),
  description: z.string().min(1).max(13),
  callbackUrl: z.url({ protocol: /^https?$/ }),
});

type Response = { status: number; body: unknown };

export type DarajaClient = ReturnType<typeof createDarajaClient>;

/**
 * Typed client for Safaricom's Daraja API: OAuth (token cached in Redis),
 * STK push and STK Push Query.
 */
export const createDarajaClient = ({
  consumerKey,
  consumerSecret,
  shortcode,
  passkey,
  baseUrl = DARAJA_BASE_URLS.sandbox,
  redis,
  cachePrefix = "mpesa",
  timeoutMs = 10_000,
  now = () => new Date(),
}: DarajaClientOptions) => {
  // One cache entry per app (consumer key) and Daraja environment. The key
  // holds a hash, so the consumer key itself never lands in Redis.
  const tokenCacheKey = `${cachePrefix}:oauth:${createHash("sha256")
    .update(`${baseUrl}\n${consumerKey}`)
    .digest("hex")
    .slice(0, 32)}`;

  const request = async (
    path: string,
    init: { method: "GET" | "POST"; authorization: string; body?: unknown },
  ): Promise<Response> => {
    let res: globalThis.Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: init.authorization,
          accept: "application/json",
          ...(init.body !== undefined && {
            "content-type": "application/json",
          }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new DarajaError(`Daraja request to ${path} failed`, { cause });
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch (cause) {
      throw new DarajaError(`Daraja returned invalid JSON from ${path}`, {
        status: res.status,
        cause,
      });
    }
    return { status: res.status, body };
  };

  const fail = (path: string, { status, body }: Response): never => {
    const error = errorResponse.safeParse(body);
    if (error.success) {
      throw new DarajaError(error.data.errorMessage, {
        status,
        code: error.data.errorCode,
        requestId: error.data.requestId,
      });
    }
    throw new DarajaError(`Daraja ${path} returned HTTP ${status}`, {
      status,
    });
  };

  const parse = <T>(schema: z.ZodType<T>, path: string, res: Response): T => {
    const result = schema.safeParse(res.body);
    if (!result.success) {
      throw new DarajaError(`Unexpected response from Daraja ${path}`, {
        status: res.status,
        cause: result.error,
      });
    }
    return result.data;
  };

  const fetchToken = async () => {
    const path = "/oauth/v1/generate?grant_type=client_credentials";
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
      "base64",
    );
    const res = await request(path, {
      method: "GET",
      authorization: `Basic ${basic}`,
    });
    if (res.status !== 200) fail(path, res);
    const token = parse(tokenResponse, path, res);

    const ttlSeconds = Math.max(
      1,
      token.expires_in - TOKEN_REFRESH_MARGIN_SECONDS,
    );
    // A cache failure only costs an extra token fetch, so don't fail on it.
    await redis
      .set(tokenCacheKey, token.access_token, "EX", ttlSeconds)
      .catch(() => undefined);
    return token.access_token;
  };

  // Concurrent callers in this process share one in-flight token fetch.
  let inFlight: Promise<string> | undefined;

  const accessToken = async () => {
    const cached = await redis.get(tokenCacheKey).catch(() => null);
    if (cached) return cached;

    inFlight ??= fetchToken().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  /** Drops the cached token, e.g. after Daraja rejects it. */
  const invalidateToken = async () => {
    await redis.del(tokenCacheKey).catch(() => undefined);
  };

  /**
   * POSTs with a bearer token. If Daraja rejects the token (revoked or
   * expired early), fetches a fresh one and retries once.
   */
  const authorizedPost = async (path: string, body: unknown) => {
    let res = await request(path, {
      method: "POST",
      authorization: `Bearer ${await accessToken()}`,
      body,
    });
    if (res.status === 401) {
      await invalidateToken();
      res = await request(path, {
        method: "POST",
        authorization: `Bearer ${await accessToken()}`,
        body,
      });
    }
    return res;
  };

  const credentials = () => {
    const timestamp = mpesaTimestamp(now());
    return {
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
    };
  };

  /** Sends an STK push prompt to the customer's phone. */
  const stkPush = async (input: StkPushRequest): Promise<StkPushResult> => {
    const { amount, accountReference, description, callbackUrl } =
      stkPushRequest.parse(input);
    const phone = normalizePhone(input.phone);
    if (!phone) {
      throw new RangeError("phone must be a Kenyan mobile number");
    }

    const path = "/mpesa/stkpush/v1/processrequest";
    const res = await authorizedPost(path, {
      ...credentials(),
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference,
      TransactionDesc: description,
    });
    if (res.status !== 200) fail(path, res);

    const data = parse(stkPushResponse, path, res);
    if (data.ResponseCode !== "0") {
      throw new DarajaError(data.ResponseDescription, {
        status: res.status,
        code: data.ResponseCode,
      });
    }
    return {
      merchantRequestId: data.MerchantRequestID,
      checkoutRequestId: data.CheckoutRequestID,
      responseDescription: data.ResponseDescription,
      customerMessage: data.CustomerMessage,
    };
  };

  /**
   * Asks Daraja how an STK push ended. Used by reconciliation when a callback
   * never arrives. Returns `pending` while the customer hasn't responded.
   */
  const stkQuery = async (
    checkoutRequestId: string,
  ): Promise<StkQueryResult> => {
    const path = "/mpesa/stkpushquery/v1/query";
    const res = await authorizedPost(path, {
      ...credentials(),
      CheckoutRequestID: checkoutRequestId,
    });

    if (res.status !== 200) {
      const error = errorResponse.safeParse(res.body);
      if (
        error.success &&
        error.data.errorCode === STILL_PROCESSING_ERROR_CODE
      ) {
        return { status: "pending" };
      }
      fail(path, res);
    }

    const data = parse(stkQueryResponse, path, res);
    return {
      status: "completed",
      resultCode: data.ResultCode,
      resultDesc: data.ResultDesc,
      merchantRequestId: data.MerchantRequestID,
      checkoutRequestId: data.CheckoutRequestID,
    };
  };

  return { accessToken, invalidateToken, stkPush, stkQuery };
};
