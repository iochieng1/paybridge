import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = "x-paybridge-signature";

/** How old a signature may be before a receiver should reject it as a replay. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

const hmac = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/**
 * Signs a webhook body. The timestamp is part of the signed string, so a
 * captured request can't be replayed later with a fresh timestamp.
 */
export const signPayload = (
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
) => `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;

export type VerifyResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: "malformed" | "mismatch" | "expired" };

/**
 * What a merchant runs on receipt (the README has a standalone copy). The body
 * must be the raw bytes as received: re-serialised JSON won't match.
 */
export const verifySignature = (
  secret: string,
  header: string | undefined,
  body: string,
  {
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    now = Math.floor(Date.now() / 1000),
  }: { toleranceSeconds?: number; now?: number } = {},
): VerifyResult => {
  if (!header) return { valid: false, reason: "malformed" };

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    return { valid: false, reason: "malformed" };
  }

  const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
  const matches = signatures.some((signature) =>
    timingSafeEqual(expected, Buffer.from(signature, "hex")),
  );
  if (!matches) return { valid: false, reason: "mismatch" };

  // Checked after the HMAC, so an attacker can't learn anything from it
  // without a valid signature. Future timestamps are bounded too.
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, timestamp };
};
