import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { isPrivateAddress } from "../src/webhooks/http.js";
import {
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  generateWebhookSecret,
} from "../src/webhooks/secrets.js";
import { signPayload, verifySignature } from "../src/webhooks/signature.js";

const SECRET = "whsec_test-secret";
const BODY = JSON.stringify({ id: "evt_1", type: "payment.succeeded" });
const NOW = 1_794_000_000;

describe("webhook signatures", () => {
  it("signs t.body with HMAC-SHA256 in the documented format", () => {
    const header = signPayload(SECRET, BODY, NOW);
    const expected = createHmac("sha256", SECRET)
      .update(`${NOW}.${BODY}`)
      .digest("hex");

    expect(header).toBe(`t=${NOW},v1=${expected}`);
  });

  it("accepts a fresh, untampered signature", () => {
    const header = signPayload(SECRET, BODY, NOW);

    expect(verifySignature(SECRET, header, BODY, { now: NOW + 30 })).toEqual({
      valid: true,
      timestamp: NOW,
    });
  });

  it("rejects a tampered body", () => {
    const header = signPayload(SECRET, BODY, NOW);
    const tampered = BODY.replace("succeeded", "failed");

    expect(verifySignature(SECRET, header, tampered, { now: NOW })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it("rejects a body that was re-serialised", () => {
    const header = signPayload(SECRET, BODY, NOW);
    const reformatted = JSON.stringify(JSON.parse(BODY), null, 2);

    expect(
      verifySignature(SECRET, header, reformatted, { now: NOW }).valid,
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signPayload("whsec_other", BODY, NOW);

    expect(verifySignature(SECRET, header, BODY, { now: NOW })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it("rejects a replay outside the tolerance window, in either direction", () => {
    const header = signPayload(SECRET, BODY, NOW);

    expect(
      verifySignature(SECRET, header, BODY, { now: NOW + 300 }).valid,
    ).toBe(true);
    expect(verifySignature(SECRET, header, BODY, { now: NOW + 301 })).toEqual({
      valid: false,
      reason: "expired",
    });
    expect(verifySignature(SECRET, header, BODY, { now: NOW - 301 })).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects a replay with a fresh timestamp but the old signature", () => {
    const original = signPayload(SECRET, BODY, NOW);
    const v1 = original.split("v1=")[1]!;
    const replayed = `t=${NOW + 3600},v1=${v1}`;

    expect(
      verifySignature(SECRET, replayed, BODY, { now: NOW + 3600 }),
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  it("accepts any matching v1 when several are sent", () => {
    const good = signPayload(SECRET, BODY, NOW).split("v1=")[1]!;
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=${good}`;

    expect(verifySignature(SECRET, header, BODY, { now: NOW }).valid).toBe(
      true,
    );
  });

  it.each([
    undefined,
    "",
    "garbage",
    `t=${NOW}`,
    `v1=${"a".repeat(64)}`,
    `t=abc,v1=${"a".repeat(64)}`,
    `t=${NOW},v1=short`,
  ])("rejects a malformed header: %s", (header) => {
    expect(verifySignature(SECRET, header, BODY, { now: NOW })).toEqual({
      valid: false,
      reason: "malformed",
    });
  });
});

describe("webhook secret encryption", () => {
  const key = deriveEncryptionKey("a-master-key-of-at-least-32-characters");

  it("round-trips and never stores the plaintext", () => {
    const secret = generateWebhookSecret();
    const encrypted = encryptSecret(key, secret);

    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(encrypted).not.toContain(secret.slice(6));
    expect(encrypted).toMatch(/^v1\./);
    expect(decryptSecret(key, encrypted)).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    const secret = generateWebhookSecret();

    expect(encryptSecret(key, secret)).not.toBe(encryptSecret(key, secret));
  });

  it("fails on a tampered ciphertext or the wrong key", () => {
    const encrypted = encryptSecret(key, generateWebhookSecret());
    const parts = encrypted.split(".");
    const last = parts[3]!;
    parts[3] = (last[0] === "A" ? "B" : "A") + last.slice(1);

    expect(() => decryptSecret(key, parts.join("."))).toThrow();
    expect(() =>
      decryptSecret(
        deriveEncryptionKey("a-different-key-also-32-chars-long"),
        encrypted,
      ),
    ).toThrow();
    expect(() => decryptSecret(key, "not-encrypted")).toThrow();
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "196.201.214.200",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ])("allows %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
