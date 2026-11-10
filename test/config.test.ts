import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(validEnv)).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      TRUST_PROXY: false,
    });
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
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*JWT_SECRET/,
    );
  });

  it("rejects a JWT_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: "short" })).toThrow(
      /JWT_SECRET/,
    );
  });
});
