import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { refreshTokens } from "../db/schema.js";

export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

export type RotateResult =
  | { ok: true; merchantId: string; refreshToken: string }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "reused" };

/** Only the SHA-256 hash is stored, so a database leak can't be replayed. */
export const hashRefreshToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/**
 * Serialises every rotation and revocation within one family. Without it, a
 * family revocation running alongside a rotation could miss the token the
 * rotation is inserting, and the newest token would survive.
 */
const lockFamily = (tx: Tx, familyId: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${familyId}, 0))`,
  );

const revokeFamilyLocked = (tx: Tx, familyId: string) =>
  tx
    .update(refreshTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
      ),
    );

const insertToken = async (
  db: Executor,
  merchantId: string,
  familyId: string,
) => {
  // 256 bits of entropy: unguessable, so a fast hash (not argon2) is enough.
  const token = randomBytes(32).toString("base64url");
  await db.insert(refreshTokens).values({
    merchantId,
    familyId,
    tokenHash: hashRefreshToken(token),
    expiresAt: sql`now() + make_interval(secs => ${REFRESH_TOKEN_TTL_SECONDS})`,
  });
  return token;
};

/** Starts a new token family. Called on login. */
export const issueRefreshToken = (db: Database, merchantId: string) =>
  insertToken(db, merchantId, randomUUID());

const findFamilyId = async (tx: Tx, tokenHash: string) => {
  const [row] = await tx
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row?.familyId;
};

/**
 * Consumes a refresh token and issues its successor in the same family.
 * Presenting a token that was already used means it was copied: the whole
 * family is revoked, including the newest token.
 */
export const rotateRefreshToken = (
  db: Database,
  token: string,
): Promise<RotateResult> =>
  db.transaction(async (tx) => {
    const tokenHash = hashRefreshToken(token);
    const familyId = await findFamilyId(tx, tokenHash);
    if (!familyId) return { ok: false, reason: "unknown" };

    await lockFamily(tx, familyId);

    // Re-read under the lock: a concurrent request may have just used it.
    const [row] = await tx
      .select({
        merchantId: refreshTokens.merchantId,
        expired: sql<boolean>`${refreshTokens.expiresAt} <= now()`,
        usedAt: refreshTokens.usedAt,
        revokedAt: refreshTokens.revokedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash));

    if (!row) return { ok: false, reason: "unknown" };
    if (row.revokedAt) return { ok: false, reason: "revoked" };
    if (row.usedAt) {
      await revokeFamilyLocked(tx, familyId);
      return { ok: false, reason: "reused" };
    }
    if (row.expired) return { ok: false, reason: "expired" };

    await tx
      .update(refreshTokens)
      .set({ usedAt: sql`now()` })
      .where(eq(refreshTokens.tokenHash, tokenHash));

    const refreshToken = await insertToken(tx, row.merchantId, familyId);
    return { ok: true, merchantId: row.merchantId, refreshToken };
  });

/** Revokes the family the token belongs to. Unknown tokens are a no-op. */
export const revokeRefreshTokenFamily = (db: Database, token: string) =>
  db.transaction(async (tx) => {
    const familyId = await findFamilyId(tx, hashRefreshToken(token));
    if (!familyId) return;
    await lockFamily(tx, familyId);
    await revokeFamilyLocked(tx, familyId);
  });
