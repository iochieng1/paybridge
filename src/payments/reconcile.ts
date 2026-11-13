import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";
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

export type ReconcileSummary = {
  checked: number;
  settled: number;
  stillPending: number;
  errors: number;
};

/**
 * Settles payments whose callback never arrived. Each stale PENDING payment is
 * looked up with STK Push Query and the result goes through the same
 * forward-only transition as a callback, so a callback arriving at the same
 * moment, a second worker or a re-run after a crash can't apply it twice.
 *
 * Payments without a checkout_request_id (the push outcome was unclear) can't
 * be queried and are left for their callback: marking them failed could be
 * wrong if the customer did pay.
 */
export const reconcilePendingPayments = async (
  {
    db,
    daraja,
    log,
    onFinal,
  }: {
    db: Database;
    daraja: DarajaClient;
    log: FastifyBaseLogger;
    onFinal: (payment: Payment) => Promise<void>;
  },
  {
    staleAfterSeconds = RECONCILE_AFTER_SECONDS,
    limit = RECONCILE_BATCH_SIZE,
  }: { staleAfterSeconds?: number; limit?: number } = {},
): Promise<ReconcileSummary> => {
  const stale = await db
    .select({
      id: payments.id,
      checkoutRequestId: payments.checkoutRequestId,
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
    errors: 0,
  };

  // Bumps updated_at so a payment Daraja can't settle yet goes to the back of
  // the queue instead of crowding out newer ones on every run.
  const deferred = (paymentId: string) =>
    db
      .update(payments)
      .set({ updatedAt: sql`now()` })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "PENDING")));

  for (const { id, checkoutRequestId } of stale) {
    const paymentLog = log.child({ paymentId: id });
    try {
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
