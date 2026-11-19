import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type { Database } from "../db/client.js";
import { payments } from "../db/schema.js";
import { DarajaError, type DarajaClient } from "../mpesa/daraja.js";
import { statusForResultCode } from "./callbacks.js";
import { type Payment, transitionPayment } from "./payments.js";

/** A PENDING payment untouched for this long is checked with STK Push Query. */
export const RECONCILE_AFTER_SECONDS = 120;

/** Most payments checked per run, so one run can't hammer Daraja. */
export const RECONCILE_BATCH_SIZE = 50;

/**
 * A PENDING payment with no checkout id (the push outcome was unclear) that's
 * this old is given up on. STK prompts expire within minutes and Daraja calls
 * back soon after, so a callback that hasn't come by now won't.
 */
export const RESOLVE_AFTER_SECONDS = 60 * 60;

export const UNRESOLVED_RESULT_DESC =
  "M-Pesa never confirmed whether this payment went through. Check your M-Pesa statement for the account reference before fulfilling or charging again.";

export type ReconcileSummary = {
  checked: number;
  settled: number;
  stillPending: number;
  /** Moved to UNRESOLVED: no checkout id and no callback in time. */
  unresolved: number;
  errors: number;
};

/**
 * Payments without a checkout id can't be queried, so if their callback never
 * comes they'd stay PENDING forever and the merchant would never hear about
 * them. After `resolveAfterSeconds` they move to the final UNRESOLVED status
 * (and get a webhook). Not FAILED or TIMED_OUT: the customer may have paid.
 */
const resolveUnconfirmedPayments = async (
  {
    db,
    log,
    onFinal,
  }: {
    db: Database;
    log: FastifyBaseLogger;
    onFinal: (payment: Payment) => Promise<void>;
  },
  {
    resolveAfterSeconds,
    limit,
  }: { resolveAfterSeconds: number; limit: number },
) => {
  const stuck = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.status, "PENDING"),
        isNull(payments.checkoutRequestId),
        lt(
          payments.createdAt,
          sql`now() - make_interval(secs => ${resolveAfterSeconds})`,
        ),
      ),
    )
    .orderBy(asc(payments.createdAt))
    .limit(limit);

  let resolved = 0;
  for (const { id } of stuck) {
    const paymentLog = log.child({ paymentId: id });
    try {
      const updated = await transitionPayment(
        db,
        id,
        ["PENDING"],
        {
          status: "UNRESOLVED",
          resultDesc: UNRESOLVED_RESULT_DESC,
          completedAt: new Date(),
        },
        { type: "unresolved", payload: { after_seconds: resolveAfterSeconds } },
      );
      // undefined: a callback settled it between the select and now.
      if (!updated) continue;
      resolved += 1;
      paymentLog.warn(
        "M-Pesa never confirmed this payment's outcome; marked UNRESOLVED",
      );
      await onFinal(updated);
    } catch (err) {
      paymentLog.error({ err }, "Failed to mark payment UNRESOLVED");
    }
  }
  return resolved;
};

/**
 * Settles payments whose callback never arrived. Each stale PENDING payment is
 * looked up with STK Push Query and the result goes through the same
 * forward-only transition as a callback, so a callback arriving at the same
 * moment, a second worker or a re-run after a crash can't apply it twice.
 *
 * Payments without a checkout_request_id (the push outcome was unclear) can't
 * be queried. They're left for their callback, and marked UNRESOLVED if it
 * hasn't come after `resolveAfterSeconds`.
 */
export const reconcilePendingPayments = async (
  {
    db,
    darajaFor,
    log,
    onFinal,
  }: {
    db: Database;
    /** Each payment is queried with the credentials it was created with. */
    darajaFor: (credentialsId: string | null) => Promise<DarajaClient>;
    log: FastifyBaseLogger;
    onFinal: (payment: Payment) => Promise<void>;
  },
  {
    staleAfterSeconds = RECONCILE_AFTER_SECONDS,
    resolveAfterSeconds = RESOLVE_AFTER_SECONDS,
    limit = RECONCILE_BATCH_SIZE,
  }: {
    staleAfterSeconds?: number;
    resolveAfterSeconds?: number;
    limit?: number;
  } = {},
): Promise<ReconcileSummary> => {
  const unresolved = await resolveUnconfirmedPayments(
    { db, log, onFinal },
    { resolveAfterSeconds, limit },
  );

  const stale = await db
    .select({
      id: payments.id,
      checkoutRequestId: payments.checkoutRequestId,
      mpesaCredentialsId: payments.mpesaCredentialsId,
    })
    .from(payments)
    .where(
      and(
        eq(payments.status, "PENDING"),
        isNotNull(payments.checkoutRequestId),
        lt(
          payments.updatedAt,
          sql`now() - make_interval(secs => ${staleAfterSeconds})`,
        ),
      ),
    )
    .orderBy(asc(payments.updatedAt))
    .limit(limit);

  const summary: ReconcileSummary = {
    checked: stale.length,
    settled: 0,
    stillPending: 0,
    unresolved,
    errors: 0,
  };

  // Bumps updated_at so a payment Daraja can't settle yet goes to the back of
  // the queue instead of crowding out newer ones on every run.
  const deferred = (paymentId: string) =>
    db
      .update(payments)
      .set({ updatedAt: sql`now()` })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "PENDING")));

  for (const { id, checkoutRequestId, mpesaCredentialsId } of stale) {
    const paymentLog = log.child({ paymentId: id });
    try {
      const daraja = await darajaFor(mpesaCredentialsId);
      const result = await daraja.stkQuery(checkoutRequestId!);
      if (result.status === "pending") {
        summary.stillPending += 1;
        await deferred(id);
        continue;
      }

      const updated = await transitionPayment(
        db,
        id,
        ["CREATED", "PENDING"],
        {
          status: statusForResultCode(result.resultCode),
          resultCode: result.resultCode,
          resultDesc: result.resultDesc,
          completedAt: new Date(),
        },
        {
          type: "reconciled",
          payload: {
            result_code: result.resultCode,
            result_desc: result.resultDesc,
          },
        },
      );
      // undefined: a callback settled it between the select and now.
      if (updated) {
        summary.settled += 1;
        paymentLog.info(
          { status: updated.status },
          "Reconciled payment with STK Push Query",
        );
        await onFinal(updated);
      }
    } catch (err) {
      summary.errors += 1;
      if (err instanceof DarajaError) {
        paymentLog.warn({ err }, "STK Push Query failed during reconciliation");
        await deferred(id).catch(() => undefined);
      } else {
        paymentLog.error({ err }, "Failed to reconcile payment");
      }
    }
  }

  return summary;
};
