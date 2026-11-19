import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

/**
 * Derives an AES-256 key from WEBHOOK_ENCRYPTION_KEY. HKDF with a fixed
 * label means the configured value can be any long random string, and each
 * label gets its own key: webhook secrets and M-Pesa credentials never share
 * one.
 */
export const deriveEncryptionKey = (
  masterKey: string,
  label = "paybridge webhook signing secrets",
) => Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), label, 32));

export const MPESA_CREDENTIALS_KEY_LABEL = "paybridge mpesa credentials";

/** A new signing secret for a merchant: 256 random bits. */
export const generateWebhookSecret = () =>
  `whsec_${randomBytes(32).toString("base64url")}`;

/**
 * AES-256-GCM, as `v1.<iv>.<tag>.<ciphertext>` (base64url). The secret has to
 * be readable to sign payloads, so it is encrypted rather than hashed; a
 * database leak alone doesn't reveal it. GCM's tag also means a tampered row
 * fails to decrypt instead of producing a wrong secret.
 */
export const encryptSecret = (key: Buffer, plaintext: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    )
    .join(".");
};

export const decryptSecret = (key: Buffer, encrypted: string) => {
  const [version, iv, tag, ciphertext] = encrypted.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unrecognised encrypted secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};
