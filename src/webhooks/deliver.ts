import { and, eq, isNotNull } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { payments, webhookDeliveries, webhookEndpoints } from "../db/schema.js";
import {
  type Payment,
  type PaymentStatus,
  serializePayment,
} from "../payments/payments.js";
import { postWebhook } from "./http.js";
import { decryptSecret } from "./secrets.js";
import { signPayload } from "./signature.js";

/** Waits between attempts: 1 min, 5 min, 30 min, 2 h, 12 h (six attempts in all). */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** A payment in one of these never changes again, so it gets a webhook. */
export const FINAL_STATUSES: PaymentStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
];

/**
 * The webhook body. The id is derived from the payment, because each payment
 * has exactly one final status: a merchant that sees the same id twice (after
 * a retry whose 2xx got lost) can safely ignore the second.
 */
export const buildWebhookEvent = (payment: Payment) => ({
  id: `evt_${payment.id}`,
  type: `payment.${payment.status.toLowerCase()}`,
  created_at: (payment.completedAt ?? payment.updatedAt).toISOString(),
  data: serializePayment(payment),
});

export type DeliveryDeps = {
  db: Database;
  encryptionKey: Buffer;
  allowPrivateAddresses: boolean;
  timeoutMs?: number;
};

export type DeliveryOutcome =
  | { kind: "delivered"; statusCode: number }
  | { kind: "failed"; statusCode?: number; error: string }
  /** Nothing to send: no endpoint, an open payment, or already delivered. */
  | { kind: "skipped"; reason: string };

/**
 * Makes one delivery attempt for a payment's final status and logs it in
 * `webhook_deliveries`. Safe to run again after a crash: once an attempt has
 * been logged as delivered, later runs send nothing.
 */
export const deliverPaymentWebhook = async (
  { db, encryptionKey, allowPrivateAddresses, timeoutMs }: DeliveryDeps,
  paymentId: string,
  attempt: number,
  retryInMs: number | undefined,
): Promise<DeliveryOutcome> => {
  const [delivered] = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.paymentId, paymentId),
        isNotNull(webhookDeliveries.deliveredAt),
      ),
    )
    .limit(1);
  if (delivered) return { kind: "skipped", reason: "already delivered" };

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!payment) return { kind: "skipped", reason: "no such payment" };
  if (!FINAL_STATUSES.includes(payment.status)) {
    return { kind: "skipped", reason: "payment is not final" };
  }

  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.merchantId, payment.merchantId))
    .limit(1);
  if (!endpoint) return { kind: "skipped", reason: "no webhook endpoint" };

  const event = buildWebhookEvent(payment);
  const body = JSON.stringify(event);
  const secret = decryptSecret(encryptionKey, endpoint.secretEncrypted);
  const result = await postWebhook(
    endpoint.url,
    body,
    {
      "x-paybridge-signature": signPayload(secret, body),
      "x-paybridge-event-id": event.id,
    },
    { allowPrivateAddresses, timeoutMs },
  );

  await db.insert(webhookDeliveries).values({
    paymentId,
    attempt,
    statusCode: result.statusCode ?? null,
    error: result.ok ? null : result.error,
    deliveredAt: result.ok ? new Date() : null,
    nextRetryAt:
      !result.ok && retryInMs !== undefined
        ? new Date(Date.now() + retryInMs)
        : null,
  });

  return result.ok
    ? { kind: "delivered", statusCode: result.statusCode }
    : { kind: "failed", statusCode: result.statusCode, error: result.error };
};
