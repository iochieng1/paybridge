import { and, eq, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Database } from "../db/client.js";
import { mpesaCredentials } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../webhooks/secrets.js";
import { createDarajaClient, type DarajaClient } from "./daraja.js";

export type MpesaCredentialsRow = typeof mpesaCredentials.$inferSelect;

export type MpesaCredentialsInput = {
  shortcode: string;
  shortcodeType: "paybill" | "till";
  tillNumber?: string;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
};

/** Daraja clients kept per credentials id; each holds decrypted secrets. */
const CACHE_SIZE = 500;

/** The API view: never the secrets, only enough to recognise the app. */
export const serializeMpesaCredentials = (row: MpesaCredentialsRow) => ({
  id: row.id,
  shortcode: row.shortcode,
  type: row.shortcodeType,
  till_number: row.tillNumber,
  consumer_key: `••••${row.consumerKeyLast4}`,
  created_at: row.createdAt.toISOString(),
});

/**
 * Hands out the Daraja client for a payment: the merchant's own credentials,
 * or PayBridge's (`platform`) for payments made without them. A payment keeps
 * the credentials it was created with, even after the merchant replaces or
 * removes them, so its STK Push Query asks the same shortcode.
 */
export const createDarajaClients = ({
  db,
  redis,
  baseUrl,
  encryptionKey,
  platform,
  timeoutMs,
}: {
  db: Database;
  redis: Redis;
  baseUrl: string;
  /** Derived with MPESA_CREDENTIALS_KEY_LABEL. */
  encryptionKey: Buffer;
  platform: DarajaClient;
  timeoutMs?: number;
}) => {
  const cache = new Map<string, DarajaClient>();

  const clientFor = (row: MpesaCredentialsRow) =>
    createDarajaClient({
      consumerKey: decryptSecret(encryptionKey, row.consumerKeyEncrypted),
      consumerSecret: decryptSecret(encryptionKey, row.consumerSecretEncrypted),
      passkey: decryptSecret(encryptionKey, row.passkeyEncrypted),
      shortcode: row.shortcode,
      shortcodeType: row.shortcodeType,
      tillNumber: row.tillNumber ?? undefined,
      baseUrl,
      redis,
      timeoutMs,
    });

  const remember = (id: string, client: DarajaClient) => {
    cache.set(id, client);
    if (cache.size > CACHE_SIZE) {
      cache.delete(cache.keys().next().value!);
    }
    return client;
  };

  /** The client for a payment's `mpesa_credentials_id`, revoked or not. */
  const forCredentials = async (
    credentialsId: string | null,
  ): Promise<DarajaClient> => {
    if (credentialsId === null) return platform;
    const cached = cache.get(credentialsId);
    if (cached) {
      // Map keeps insertion order: move it to the back, so eviction is LRU.
      cache.delete(credentialsId);
      cache.set(credentialsId, cached);
      return cached;
    }
    const [row] = await db
      .select()
      .from(mpesaCredentials)
      .where(eq(mpesaCredentials.id, credentialsId))
      .limit(1);
    if (!row) throw new Error(`M-Pesa credentials ${credentialsId} not found`);
    return remember(row.id, clientFor(row));
  };

  /** The merchant's credentials in use, if any, with their client. */
  const activeFor = async (merchantId: string) => {
    const [row] = await db
      .select()
      .from(mpesaCredentials)
      .where(
        and(
          eq(mpesaCredentials.merchantId, merchantId),
          isNull(mpesaCredentials.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    return { id: row.id, client: await forCredentials(row.id) };
  };

  /**
   * Checks a consumer key and secret by fetching an OAuth token with them.
   * Throws DarajaError if Daraja rejects them or can't be reached. (Daraja has
   * no way to check a passkey short of sending a real STK push.)
   */
  const verify = async (input: MpesaCredentialsInput) => {
    const client = createDarajaClient({
      ...input,
      tillNumber: input.tillNumber,
      baseUrl,
      redis,
      // Its own cache namespace, so a failed check leaves nothing behind.
      cachePrefix: "mpesa-verify",
      timeoutMs,
    });
    await client.invalidateToken();
    await client.accessToken();
  };

  /** Encrypts input for storage. */
  const encrypt = (input: MpesaCredentialsInput) => ({
    shortcode: input.shortcode,
    shortcodeType: input.shortcodeType,
    tillNumber: input.shortcodeType === "till" ? input.tillNumber! : null,
    consumerKeyEncrypted: encryptSecret(encryptionKey, input.consumerKey),
    consumerSecretEncrypted: encryptSecret(encryptionKey, input.consumerSecret),
    passkeyEncrypted: encryptSecret(encryptionKey, input.passkey),
    consumerKeyLast4: input.consumerKey.slice(-4),
  });

  return { platform, forCredentials, activeFor, verify, encrypt };
};

export type DarajaClients = ReturnType<typeof createDarajaClients>;
