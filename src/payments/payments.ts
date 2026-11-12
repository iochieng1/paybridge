import { createHash, randomBytes } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { paymentEvents, payments, paymentStatus } from "../db/schema.js";
import { DarajaError, type DarajaClient } from "../mpesa/daraja.js";
import { normalizePhone } from "../mpesa/phone.js";

export type Payment = typeof payments.$inferSelect;
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];

export const PAYMENT_STATUSES = paymentStatus.enumValues;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Each payment gets its own secret callback URL, because Daraja doesn't sign
 * callbacks: knowing the URL is what proves a callback came from Daraja. The
 * token has 256 random bits and only its SHA-256 hash is stored.
 */
export const hashCallbackToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const generateCallbackToken = () => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashCallbackToken(token) };
};

export const callbackUrl = (publicBaseUrl: string, token: string) =>
  `${publicBaseUrl}/v1/callbacks/mpesa/${token}`;

/** The API representation of a payment. */
export const serializePayment = (payment: Payment) => ({
  id: payment.id,
  status: payment.status,
  amount: payment.amount,
  phone: payment.phone,
  reference: payment.accountReference,
  description: payment.description,
  checkout_request_id: payment.checkoutRequestId,
  mpesa_receipt: payment.mpesaReceipt,
  result_code: payment.resultCode,
  result_desc: payment.resultDesc,
  created_at: payment.createdAt.toISOString(),
  updated_at: payment.updatedAt.toISOString(),
  completed_at: payment.completedAt?.toISOString() ?? null,
});

export type SerializedPayment = ReturnType<typeof serializePayment>;

const recordEvent = (
  tx: Transaction,
  paymentId: string,
  type: string,
  payload: Record<string, unknown>,
) => tx.insert(paymentEvents).values({ paymentId, type, payload });

/**
 * Moves a payment to a new state, but only from one of `from`, and appends an
 * audit event in the same transaction. Returns undefined (and records nothing)
 * if the payment wasn't in one of those states: that's how the state machine
 * stays forward-only even when callbacks and requests race.
 */
export const transitionPayment = async (
  db: Database,
  paymentId: string,
  from: PaymentStatus[],
  changes: Partial<Omit<Payment, "id" | "merchantId" | "createdAt">> & {
    status: PaymentStatus;
  },
  event: { type: string; payload?: Record<string, unknown> },
) =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .update(payments)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(and(eq(payments.id, paymentId), inArray(payments.status, from)))
      .returning();
    if (!row) return undefined;
    await recordEvent(tx, paymentId, event.type, {
      status: changes.status,
      ...event.payload,
    });
    return row;
  });

const loadPayment = async (db: Database, paymentId: string) => {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  return row!;
};

/**
 * True if Daraja definitely did not accept the push: it answered with an
 * error code, or with a 4xx. A timeout, a network error, a 5xx without an
 * error code or an unreadable body leaves it unknown whether the customer was
 * prompted.
 */
export const isDefinitiveRejection = (err: DarajaError) => {
  const { status, code } = err.details;
  return (
    code !== undefined ||
    (status !== undefined && status < 500 && status >= 400)
  );
};

/** Thrown when creating a payment fails; says whether Daraja may have been called. */
export class PaymentCreationError extends Error {
  override name = "PaymentCreationError";

  constructor(
    readonly pushAttempted: boolean,
    cause: unknown,
  ) {
    super("Failed to create payment", { cause });
  }
}

export type CreatePaymentInput = {
  phone: string;
  amount: number;
  reference: string;
  description: string;
};

/**
 * Creates a payment and sends the STK push:
 * - Daraja accepts → PENDING, with checkout_request_id stored.
 * - Daraja rejects → FAILED, with result_desc.
 * - Outcome unknown (timeout, 5xx) → PENDING without a checkout id. It is not
 *   retried, since that could prompt the customer twice; the callback (which
 *   finds the payment by its token) or reconciliation settles it.
 */
export const createPayment = async (
  {
    db,
    daraja,
    publicBaseUrl,
  }: { db: Database; daraja: DarajaClient; publicBaseUrl: string },
  merchantId: string,
  input: CreatePaymentInput,
): Promise<Payment> => {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new RangeError("phone must be a Kenyan mobile number");
  const { token, tokenHash } = generateCallbackToken();

  let payment: Payment;
  try {
    payment = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(payments)
        .values({
          merchantId,
          amount: input.amount,
          phone,
          accountReference: input.reference,
          description: input.description,
          callbackTokenHash: tokenHash,
        })
        .returning();
      await recordEvent(tx, row!.id, "created", {
        status: "CREATED",
        amount: input.amount,
        reference: input.reference,
      });
      return row!;
    });
  } catch (err) {
    throw new PaymentCreationError(false, err);
  }

  try {
    let accepted;
    try {
      accepted = await daraja.stkPush({
        amount: payment.amount,
        phone: payment.phone,
        accountReference: payment.accountReference,
        description: payment.description,
        callbackUrl: callbackUrl(publicBaseUrl, token),
      });
    } catch (err) {
      // stkPush throws anything other than DarajaError only while validating
      // its input, before any network call.
      if (!(err instanceof DarajaError)) {
        throw new PaymentCreationError(false, err);
      }
      const details = {
        message: err.message,
        http_status: err.details.status ?? null,
        code: err.details.code ?? null,
      };
      if (isDefinitiveRejection(err)) {
        return (
          (await transitionPayment(
            db,
            payment.id,
            ["CREATED"],
            {
              status: "FAILED",
              resultDesc: err.message,
              completedAt: new Date(),
            },
            { type: "stk_push_rejected", payload: details },
          )) ?? (await loadPayment(db, payment.id))
        );
      }
      return (
        (await transitionPayment(
          db,
          payment.id,
          ["CREATED"],
          { status: "PENDING" },
          { type: "stk_push_unknown", payload: details },
        )) ?? (await loadPayment(db, payment.id))
      );
    }

    return await db.transaction(async (tx) => {
      // A callback can, in theory, beat this update. Then the payment is
      // already final: keep its status and only fill in the checkout ids.
      const [row] = await tx
        .update(payments)
        .set({
          checkoutRequestId: accepted.checkoutRequestId,
          merchantRequestId: accepted.merchantRequestId,
          status: sql`case when ${payments.status} = 'CREATED' then 'PENDING'::payment_status else ${payments.status} end`,
          updatedAt: sql`now()`,
        })
        .where(eq(payments.id, payment.id))
        .returning();
      await recordEvent(tx, payment.id, "stk_push_accepted", {
        status: row!.status,
        checkout_request_id: accepted.checkoutRequestId,
        merchant_request_id: accepted.merchantRequestId,
      });
      return row!;
    });
  } catch (err) {
    if (err instanceof PaymentCreationError) throw err;
    // Daraja may have been called: the caller must not allow a blind retry.
    throw new PaymentCreationError(true, err);
  }
};
