import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

// What a Drizzle error looks like: the query and its parameters in the message.
const LEAKY_MESSAGE =
  'Failed query: insert into "merchants" ("email", "password_hash") values ($1, $2)\n' +
  "params: someone@example.com,$argon2id$v=19$m=19456,t=2,p=1$c2VjcmV0$aGFzaA";

describe("error responses", () => {
  let app: App;
  const logLines: string[] = [];

  beforeAll(async () => {
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    app = await buildTestApp({ LOG_LEVEL: "error" }, { logStream });

    app.get("/test/unexpected", async () => {
      throw new Error(LEAKY_MESSAGE);
    });
    app.get("/test/unavailable", async () => {
      throw Object.assign(new Error(`Upstream said: ${LEAKY_MESSAGE}`), {
        statusCode: 503,
      });
    });
    app.get("/test/conflict", async () => {
      throw Object.assign(new Error("That name is taken"), {
        statusCode: 409,
      });
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("never sends an unexpected error's message to the client", async () => {
    const res = await app.inject({ method: "GET", url: "/test/unexpected" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Something went wrong on our side. Please try again later.",
    });
    expect(res.body).not.toContain("argon2id");
    expect(res.body).not.toContain("Failed query");
  });

  it("keeps the status of a 5xx error but hides its message", async () => {
    const res = await app.inject({ method: "GET", url: "/test/unavailable" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      statusCode: 503,
      error: "Service Unavailable",
    });
    expect(res.body).not.toContain("Upstream said");
  });

  it("still logs the full error for debugging", async () => {
    logLines.length = 0;
    await app.inject({ method: "GET", url: "/test/unexpected" });

    expect(logLines.join("")).toContain("Failed query");
  });

  it("keeps the message on 4xx errors, which the client has to fix", async () => {
    const res = await app.inject({ method: "GET", url: "/test/conflict" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ message: "That name is taken" });
  });

  it("keeps validation messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "not-an-email" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBeTruthy();
  });
});
