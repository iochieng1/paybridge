import { eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { paymentEvents, payments } from "../db/schema.js";
import { DarajaError, type DarajaClient } from "../mpesa/daraja.js";
import {
  hashCallbackToken,
  type Payment,
  type PaymentStatus,
  transitionPayment,
} from "./payments.js";

/** The `Body.stkCallback` object Daraja posts, after validation. */
export type StkCallback = {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: { Item: { Name: string; Value?: string | number }[] };
};

/** Only these can still change; every other status is final. */
const OPEN_STATUSES: PaymentStatus[] = ["CREATED", "PENDING"];

export const statusForResultCode = (resultCode: number): PaymentStatus => {
  if (resultCode === 0) return "SUCCEEDED";
  if (resultCode === 1032) return "CANCELLED";
  if (resultCode === 1037) return "TIMED_OUT";
  return "FAILED";
};

export const findPaymentByCallbackToken = async (
  db: Database,
  token: string,
) => {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.callbackTokenHash, hashCallbackToken(token)))
    .limit(1);
  return row;
};

export type CallbackOutcome =
  /** The payment moved to its final status. */
  | { kind: "applied"; payment: Payment; verifiedByQuery: boolean }
  /** The payment was already final: a duplicate or late callback. Nothing changed. */
  | { kind: "ignored" }
  /** Suspicious, and STK Push Query says the payment is still in progress. */
  | { kind: "unverified"; problems: string[] }
  /** Suspicious, and STK Push Query couldn't be reached. Nothing changed. */
  | { kind: "verification_failed"; problems: string[]; error: DarajaError };

const metadataOf = (callback: StkCallback) =>
  Object.fromEntries(
    (callback.CallbackMetadata?.Item ?? []).map((item) => [
      item.Name,
      item.Value,
    ]),
  );

/**
 * What doesn't add up about this callback for this payment. Anything listed
 * here means the callback isn't trusted until STK Push Query confirms it.
 */
export const callbackProblems = (payment: Payment, callback: StkCallback) => {
  const problems: string[] = [];
  if (!payment.checkoutRequestId) {
    problems.push("payment has no checkout_request_id");
  } else if (callback.CheckoutRequestID !== payment.checkoutRequestId) {
    problems.push("CheckoutRequestID does not match the payment");
  }
  if (callback.ResultCode === 0) {
    const metadata = metadataOf(callback);
    if (typeof metadata.MpesaReceiptNumber !== "string") {
      problems.push("success without MpesaReceiptNumber");
    }
    if (Number(metadata.Amount) !== payment.amount) {
      problems.push(
        `Amount ${String(metadata.Amount)} does not match ${payment.amount}`,
      );
    }
  }
  return problems;
};

/**
 * Applies an STK callback to its payment. The state machine only moves
 * forward: the update is `WHERE status IN ('CREATED', 'PENDING')`, so a
 * duplicate, a replay or a late callback for a final payment changes nothing
 * and records no event, however many arrive and however they race.
 *
 * A callback whose data doesn't match the payment is confirmed with STK Push
 * Query first, and then only the query's result is used: its receipt number
 * is never stored, since nothing vouches for it.
 */
export const applyStkCallback = async (
  { db, daraja }: { db: Database; daraja: DarajaClient },
  payment: Payment,
  callback: StkCallback,
): Promise<CallbackOutcome> => {
  if (!OPEN_STATUSES.includes(payment.status)) return { kind: "ignored" };

  const problems = callbackProblems(payment, callback);

  if (problems.length === 0) {
    const receipt = metadataOf(callback).MpesaReceiptNumber as
      string | undefined;
    try {
      const updated = await transitionPayment(
        db,
        payment.id,
        OPEN_STATUSES,
        {
          status: statusForResultCode(callback.ResultCode),
          resultCode: callback.ResultCode,
          resultDesc: callback.ResultDesc,
          mpesaReceipt: receipt ?? null,
          completedAt: new Date(),
        },
        {
          type: "callback_applied",
          payload: {
            result_code: callback.ResultCode,
            result_desc: callback.ResultDesc,
            mpesa_receipt: receipt ?? null,
          },
        },
      );
      return updated
        ? { kind: "applied", payment: updated, verifiedByQuery: false }
        : { kind: "ignored" };
    } catch (err) {
      // mpesa_receipt is unique: a receipt already used by another payment
      // means this callback can't be trusted as-is.
      if (!isUniqueViolation(err)) throw err;
      problems.push("MpesaReceiptNumber already belongs to another payment");
    }
  }

  // Ask Daraja about this payment's own checkout, not the callback's claim,
  // unless the payment never got one (the push outcome was unclear).
  const checkoutRequestId =
    payment.checkoutRequestId ?? callback.CheckoutRequestID;

  let result;
  try {
    result = await daraja.stkQuery(checkoutRequestId);
  } catch (err) {
    if (!(err instanceof DarajaError)) throw err;
    return { kind: "verification_failed", problems, error: err };
  }

  if (result.status === "pending") {
    await db.insert(paymentEvents).values({
      paymentId: payment.id,
      type: "callback_unverified",
      payload: { problems, checkout_request_id: checkoutRequestId },
    });
    return { kind: "unverified", problems };
  }

  const updated = await transitionPayment(
    db,
    payment.id,
    OPEN_STATUSES,
    {
      status: statusForResultCode(result.resultCode),
      resultCode: result.resultCode,
      resultDesc: result.resultDesc,
      checkoutRequestId,
      completedAt: new Date(),
    },
    {
      type: "callback_verified_by_query",
      payload: {
        problems,
        result_code: result.resultCode,
        result_desc: result.resultDesc,
      },
    },
  );
  return updated
    ? { kind: "applied", payment: updated, verifiedByQuery: true }
    : { kind: "ignored" };
};
