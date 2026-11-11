import { describe, expect, it } from "vitest";

import { mpesaTimestamp, stkPassword } from "../src/mpesa/daraja.js";
import { normalizePhone } from "../src/mpesa/phone.js";

describe("mpesaTimestamp", () => {
  it.each([
    // Nairobi is UTC+3 all year, so the date rolls over at 21:00 UTC.
    ["2026-01-01T21:30:05Z", "20260102003005"],
    ["2026-06-15T08:04:09Z", "20260615110409"],
    ["2026-12-31T20:59:59Z", "20261231235959"],
    ["2026-12-31T21:00:00Z", "20270101000000"],
    ["2028-02-28T22:00:00Z", "20280229010000"],
  ])("formats %s as %s (Africa/Nairobi)", (iso, expected) => {
    expect(mpesaTimestamp(new Date(iso))).toBe(expected);
  });

  it("is 14 digits for the current time", () => {
    expect(mpesaTimestamp()).toMatch(/^\d{14}$/);
  });
});

describe("stkPassword", () => {
  it("is base64(shortcode + passkey + timestamp)", () => {
    const password = stkPassword("174379", "test-passkey", "20260102003005");

    expect(password).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(password, "base64").toString()).toBe(
      "174379test-passkey20260102003005",
    );
  });

  it("changes with the timestamp", () => {
    expect(stkPassword("174379", "pk", "20260101000000")).not.toBe(
      stkPassword("174379", "pk", "20260101000001"),
    );
  });
});

describe("normalizePhone", () => {
  it.each([
    ["0712345678", "254712345678"],
    ["712345678", "254712345678"],
    ["254712345678", "254712345678"],
    ["+254712345678", "254712345678"],
    ["+254 712 345 678", "254712345678"],
    ["0712-345-678", "254712345678"],
    ["(0712) 345678", "254712345678"],
    [" 0712345678 ", "254712345678"],
    ["0110345678", "254110345678"],
    ["110345678", "254110345678"],
    ["+254110345678", "254110345678"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["too few digits", "071234567"],
    ["too many digits", "07123456789"],
    ["a landline (020)", "0201234567"],
    ["a non-mobile prefix", "0812345678"],
    ["another country code", "+255712345678"],
    ["a double country code", "254254712345678"],
    ["letters", "07123abc78"],
    ["a 0 after the country code", "2540712345678"],
  ])("rejects %s", (_, input) => {
    expect(normalizePhone(input)).toBeUndefined();
  });
});
