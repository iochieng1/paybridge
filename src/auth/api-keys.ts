import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Database } from "../db/client.js";
import { apiKeys, merchants } from "../db/schema.js";

/**
 * Keys look like `pb_test_<prefix>_<secret>`:
 * - `pb_test_<prefix>` (12 hex chars) is stored in plaintext and used to find
 *   the row. It's safe to show in dashboards and logs.
 * - `<secret>` is 256 random bits (43 base64url chars). Only its SHA-256 hash
 *   is stored, so a database leak doesn't give anyone a working key.
 */
const KEY_MODE = "pb_test";
const API_KEY_PATTERN = /^(pb_test_[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

declare module "fastify" {
  interface FastifyInstance {
    apiKeyAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Set by apiKeyAuth: the API key the request authenticated with. */
    apiKeyId: string;
  }
}

/** The secret has 256 bits of entropy, so a fast hash (not argon2) is enough. */
export const hashApiKeySecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

export const generateApiKey = () => {
  const prefix = `${KEY_MODE}_${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  return {
    prefix,
    key: `${prefix}_${secret}`,
    keyHash: hashApiKeySecret(secret),
  };
};

/** Splits a presented key into its lookup prefix and secret, or undefined. */
export const parseApiKey = (key: string) => {
  const match = API_KEY_PATTERN.exec(key);
  return match ? { prefix: match[1]!, secret: match[2]! } : undefined;
};

const safeEqualHex = (a: string, b: string) => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Reads `Authorization: Bearer <key>`; undefined if it's missing or malformed. */
export const bearerToken = (request: FastifyRequest) => {
  const header = request.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
};

/**
 * Finds the active key and its merchant. Unknown, revoked and wrong-secret
 * keys all return undefined, so callers can't tell them apart.
 */
export const verifyApiKey = async (db: Database, key: string) => {
  const parsed = parseApiKey(key);
  if (!parsed) return undefined;

  const [row] = await db
    .select({
      id: apiKeys.id,
      keyHash: apiKeys.keyHash,
      merchant: {
        id: merchants.id,
        email: merchants.email,
        name: merchants.name,
      },
    })
    .from(apiKeys)
    .innerJoin(merchants, eq(apiKeys.merchantId, merchants.id))
    .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!row || !safeEqualHex(row.keyHash, hashApiKeySecret(parsed.secret))) {
    return undefined;
  }

  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiKeys.id, row.id));

  return { apiKeyId: row.id, merchant: row.merchant };
};

/**
 * preHandler for merchant-server routes (payments): authenticates
 * `Authorization: Bearer pb_test_…`, records `last_used_at`, and loads the
 * merchant into `request.merchant`. Missing, malformed, unknown and revoked
 * keys all get the same 401.
 */
export const apiKeyAuth = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const key = bearerToken(request);
  const result = key ? await verifyApiKey(request.server.db, key) : undefined;

  if (!result) {
    return reply.code(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing or invalid API key",
    });
  }

  request.apiKeyId = result.apiKeyId;
  request.merchant = result.merchant;
};
