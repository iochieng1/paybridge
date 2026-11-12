import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const paymentStatus = pgEnum("payment_status", [
  "CREATED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("merchants_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    // All tokens issued from one login share a family; reuse revokes the family.
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("refresh_tokens_family_idx").on(t.familyId)],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchants.id, { onDelete: "cascade" }),
  // Public lookup prefix (e.g. pb_test_ab12cd34); the secret part is only stored hashed.
  prefix: text("prefix").notNull().unique(),
  keyHash: text("key_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id),
    // Whole Kenyan shillings: Daraja only accepts integer amounts.
    amount: integer("amount").notNull(),
    // Normalised to 2547XXXXXXXX / 2541XXXXXXXX
    phone: text("phone").notNull(),
    accountReference: text("account_reference").notNull(),
    description: text("description").notNull(),
    status: paymentStatus("status").notNull().default("CREATED"),
    checkoutRequestId: text("checkout_request_id").unique(),
    merchantRequestId: text("merchant_request_id"),
    mpesaReceipt: text("mpesa_receipt").unique(),
    resultCode: integer("result_code"),
    resultDesc: text("result_desc"),
    // SHA-256 of the secret token in this payment's callback URL.
    callbackTokenHash: text("callback_token_hash").unique(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("payments_amount_positive", sql`${t.amount} > 0`),
    index("payments_merchant_created_idx").on(t.merchantId, t.createdAt),
    // Used by the reconciliation job to find stuck payments.
    index("payments_pending_idx")
      .on(t.updatedAt)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

// Append-only audit trail of everything that happened to a payment.
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("payment_events_payment_idx").on(t.paymentId)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.merchantId, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  merchantId: uuid("merchant_id")
    .primaryKey()
    .references(() => merchants.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  // Encrypted with an app-level key: it must be readable to sign payloads.
  secretEncrypted: text("secret_encrypted").notNull(),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    attempt: integer("attempt").notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_deliveries_payment_idx").on(t.paymentId)],
);
