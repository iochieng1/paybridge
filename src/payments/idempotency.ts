import { createHash } from "node:crypto";

import { and, eq, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";

/** How long a key is remembered. After that it can be reused for a new request. */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

const expiredBefore = sql`now() - make_interval(hours => ${IDEMPOTENCY_KEY_TTL_HOURS})`;

/**
 * SHA-256 of the request's meaningful fields. Keys are sorted, so field order
 * in the JSON body doesn't change the hash.
 */
export const hashRequest = (fields: Record<string, string | number>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .digest("hex");

export type IdempotencyClaim =
  /** This request owns the key and must do the work, then save its response. */
  | { kind: "claimed" }
  /** The same request already finished: send back what it got. */
  | { kind: "replay"; status: number; body: unknown }
  /** The key was used for a different request body. */
  | { kind: "mismatch" }
  /** The same request is being processed right now by another call. */
  | { kind: "in_progress" };

/**
 * Claims `key` for this merchant with `INSERT … ON CONFLICT DO NOTHING`.
 * Postgres lets exactly one concurrent insert of the same (merchant, key)
 * through, so exactly one request does the work (and sends the STK push);
 * every other gets the stored response, a mismatch or "in progress".
 */
export const claimIdempotencyKey = async (
  db: Database,
  merchantId: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> => {
  // An expired key is free again, even if the purge job hasn't removed it yet.
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.merchantId, merchantId),
        eq(idempotencyKeys.key, key),
        lt(idempotencyKeys.createdAt, expiredBefore),
      ),
    );

  const inserted = await db
    .insert(idempotencyKeys)
    .values({ merchantId, key, requestHash })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return { kind: "claimed" };

  const [row] = await db
    .select({
      requestHash: idempotencyKeys.requestHash,
      responseStatus: idempotencyKeys.responseStatus,
      responseBody: idempotencyKeys.responseBody,
    })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.merchantId, merchantId),
        eq(idempotencyKeys.key, key),
      ),
    )
    .limit(1);

  // Released between our insert and select; the client can simply retry.
  if (!row) return { kind: "in_progress" };
  if (row.requestHash !== requestHash) return { kind: "mismatch" };
  if (row.responseStatus === null) return { kind: "in_progress" };
  return { kind: "replay", status: row.responseStatus, body: row.responseBody };
};

/** Stores the response, so retries with the same key replay it. */
export const saveIdempotentResponse = async (
  db: Database,
  merchantId: string,
  key: string,
  status: number,
  body: unknown,
) => {
  await db
    .update(idempotencyKeys)
    .set({ responseStatus: status, responseBody: body })
    .where(
      and(
        eq(idempotencyKeys.merchantId, merchantId),
        eq(idempotencyKeys.key, key),
      ),
    );
};

/**
 * Frees a claimed key whose request failed before anything irreversible
 * happened, so the client can retry with the same key.
 */
export const releaseIdempotencyKey = async (
  db: Database,
  merchantId: string,
  key: string,
) => {
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.merchantId, merchantId),
        eq(idempotencyKeys.key, key),
        isNull(idempotencyKeys.responseStatus),
      ),
    );
};

/** Deletes keys older than the TTL. Returns how many were removed. */
export const purgeExpiredIdempotencyKeys = async (db: Database) => {
  const deleted = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, expiredBefore))
    .returning({ key: idempotencyKeys.key });
  return deleted.length;
};
