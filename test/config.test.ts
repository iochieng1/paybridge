import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "a".repeat(32),
  MPESA_CONSUMER_KEY: "consumer-key",
  MPESA_CONSUMER_SECRET: "consumer-secret",
  MPESA_PASSKEY: "passkey",
  PUBLIC_BASE_URL: "https://paybridge.example.com",
  WEBHOOK_ENCRYPTION_KEY: "b".repeat(32),
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(validEnv)).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      TRUST_PROXY: false,
      MPESA_SHORTCODE: "174379",
      MPESA_ENV: "sandbox",
      MPESA_CALLBACK_IP_ALLOWLIST: [],
      WEBHOOK_ALLOW_PRIVATE_URLS: false,
      RUN_WORKERS: true,
    });
  });

  it("parses the callback IP allowlist", () => {
    expect(
      loadConfig({
        ...validEnv,
        MPESA_CALLBACK_IP_ALLOWLIST: " 196.201.214.200, 196.201.214.206 ,",
      }).MPESA_CALLBACK_IP_ALLOWLIST,
    ).toEqual(["196.201.214.200", "196.201.214.206"]);
  });

  it("strips trailing slashes from PUBLIC_BASE_URL", () => {
    expect(
      loadConfig({ ...validEnv, PUBLIC_BASE_URL: "https://pay.example.com/" })
        .PUBLIC_BASE_URL,
    ).toBe("https://pay.example.com");
  });

  it.each([
    ["MPESA_ENV", "staging"],
    ["MPESA_SHORTCODE", "17-43"],
    ["PUBLIC_BASE_URL", "not a url"],
    ["MPESA_CALLBACK_IP_ALLOWLIST", "196.201.214.200,not-an-ip"],
  ])("rejects an invalid %s", (key, value) => {
    expect(() => loadConfig({ ...validEnv, [key]: value })).toThrow(
      new RegExp(key),
    );
  });

  it("coerces PORT to a number", () => {
    expect(loadConfig({ ...validEnv, PORT: "8080" }).PORT).toBe(8080);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("parses TRUST_PROXY=%s", (value, expected) => {
    expect(loadConfig({ ...validEnv, TRUST_PROXY: value }).TRUST_PROXY).toBe(
      expected,
    );
  });

  it("fails fast and lists every missing variable", () => {
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET[\s\S]*MPESA_CONSUMER_KEY[\s\S]*MPESA_CONSUMER_SECRET[\s\S]*MPESA_PASSKEY[\s\S]*PUBLIC_BASE_URL/,
    );
  });

  it("rejects a JWT_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrow(
      /JWT_SECRET/,
    );
  });
});
