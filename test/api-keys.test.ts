import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { hashApiKeySecret, parseApiKey } from "../src/auth/api-keys.js";
import { apiKeys } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

type CreatedKey = {
  id: string;
  prefix: string;
  key: string;
  created_at: string;
};

const PASSWORD = "correct-horse-battery";

describe("API keys", () => {
  let app: App;
  const logLines: string[] = [];

  beforeAll(async () => {
    // Trace level logs everything Fastify logs, including request headers.
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    app = await buildTestApp({ LOG_LEVEL: "trace" }, { logStream });

    // Stands in for the payment routes that will use apiKeyAuth.
    app.get(
      "/test/api-key-protected",
      { preHandler: app.apiKeyAuth },
      async (request) => ({
        merchantId: request.merchant.id,
        apiKeyId: request.apiKeyId,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Registers a merchant and returns its id and an access token. */
  const merchantSession = async () => {
    const email = `merchant-${randomUUID()}@example.com`;
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: PASSWORD, name: "Duka" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    return {
      merchantId: registered.json<{ id: string }>().id,
      authorization: `Bearer ${login.json<{ access_token: string }>().access_token}`,
    };
  };

  const createKey = async (authorization: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { authorization },
    });
    expect(res.statusCode).toBe(201);
    return res.json<CreatedKey>();
  };

  const listKeys = (authorization: string) =>
    app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { authorization },
    });

  const revokeKey = (authorization: string, id: string) =>
    app.inject({
      method: "DELETE",
      url: `/v1/api-keys/${id}`,
      headers: { authorization },
    });

  const callWithKey = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: "/test/api-key-protected",
      headers: authorization ? { authorization } : {},
    });

  const keyRow = async (id: string) => {
    const [row] = await app.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    return row!;
  };

  describe("POST /v1/api-keys", () => {
    it("returns a pb_test_ key once and stores only the prefix and a hash", async () => {
      const { merchantId, authorization } = await merchantSession();

      const created = await createKey(authorization);

      expect(created.key).toMatch(/^pb_test_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
      expect(created.key.startsWith(`${created.prefix}_`)).toBe(true);

      const row = await keyRow(created.id);
      const secret = parseApiKey(created.key)!.secret;
      expect(row.merchantId).toBe(merchantId);
      expect(row.prefix).toBe(created.prefix);
      expect(row.keyHash).toBe(hashApiKeySecret(secret));
      // Nothing stored anywhere in the row reveals the secret.
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain(created.key);
    });

    it("generates a different key every time", async () => {
      const { authorization } = await merchantSession();

      const [a, b] = await Promise.all([
        createKey(authorization),
        createKey(authorization),
      ]);

      expect(a.prefix).not.toBe(b.prefix);
      expect(a.key).not.toBe(b.key);
    });

    it("requires a merchant access token", async () => {
      const res = await app.inject({ method: "POST", url: "/v1/api-keys" });

      expect(res.statusCode).toBe(401);
    });

    it("doesn't accept an API key in place of an access token", async () => {
      const { authorization } = await merchantSession();
      const { key } = await createKey(authorization);

      const res = await listKeys(`Bearer ${key}`);

      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /v1/api-keys", () => {
    it("lists the merchant's active keys by prefix only, newest first", async () => {
      const { authorization } = await merchantSession();
      const first = await createKey(authorization);
      const second = await createKey(authorization);
      const revoked = await createKey(authorization);
      await revokeKey(authorization, revoked.id);

      const res = await listKeys(authorization);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [second, first].map((key) => ({
          id: key.id,
          prefix: key.prefix,
          created_at: key.created_at,
          last_used_at: null,
        })),
      });
      expect(res.body).not.toContain(first.key);
      expect(res.body).not.toContain(second.key);
    });

    it("doesn't show other merchants' keys", async () => {
      const alice = await merchantSession();
      const bob = await merchantSession();
      await createKey(alice.authorization);

      const res = await listKeys(bob.authorization);

      expect(res.json()).toEqual({ data: [] });
    });
  });

  describe("DELETE /v1/api-keys/:id", () => {
    it("revokes the key so it stops authenticating", async () => {
      const { authorization } = await merchantSession();
      const { id, key } = await createKey(authorization);
      expect((await callWithKey(`Bearer ${key}`)).statusCode).toBe(200);

      const res = await revokeKey(authorization, id);

      expect(res.statusCode).toBe(204);
      expect((await keyRow(id)).revokedAt).toBeInstanceOf(Date);
      expect((await callWithKey(`Bearer ${key}`)).statusCode).toBe(401);
    });

    it("is idempotent and keeps the original revocation time", async () => {
      const { authorization } = await merchantSession();
      const { id } = await createKey(authorization);
      await revokeKey(authorization, id);
      const revokedAt = (await keyRow(id)).revokedAt;

      const again = await revokeKey(authorization, id);

      expect(again.statusCode).toBe(204);
      expect((await keyRow(id)).revokedAt).toEqual(revokedAt);
    });

    it("returns 404 for another merchant's key and leaves it active", async () => {
      const alice = await merchantSession();
      const bob = await merchantSession();
      const { id, key } = await createKey(alice.authorization);

      const res = await revokeKey(bob.authorization, id);

      expect(res.statusCode).toBe(404);
      expect((await callWithKey(`Bearer ${key}`)).statusCode).toBe(200);
    });

    it("returns 404 for an unknown id and 400 for a malformed one", async () => {
      const { authorization } = await merchantSession();

      expect((await revokeKey(authorization, randomUUID())).statusCode).toBe(
        404,
      );
      expect((await revokeKey(authorization, "not-a-uuid")).statusCode).toBe(
        400,
      );
    });
  });

  describe("apiKeyAuth", () => {
    it("authenticates the merchant and records last_used_at", async () => {
      const { merchantId, authorization } = await merchantSession();
      const { id, key } = await createKey(authorization);
      expect((await keyRow(id)).lastUsedAt).toBeNull();

      const res = await callWithKey(`Bearer ${key}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merchantId, apiKeyId: id });
      const lastUsedAt = (await keyRow(id)).lastUsedAt;
      expect(lastUsedAt).toBeInstanceOf(Date);

      const [listed] = (await listKeys(authorization)).json().data;
      expect(listed.last_used_at).toBe(lastUsedAt!.toISOString());
    });

    it.each([
      ["no Authorization header", undefined],
      ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
      ["a malformed key", "Bearer pb_test_nope"],
      ["an unknown prefix", `Bearer pb_test_000000000000_${"a".repeat(43)}`],
    ])("returns 401 for %s", async (_, authorization) => {
      const res = await callWithKey(authorization);

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        statusCode: 401,
        error: "Unauthorized",
        message: "Missing or invalid API key",
      });
    });

    it("returns 401 for a known prefix with the wrong secret", async () => {
      const { authorization } = await merchantSession();
      const { id, prefix } = await createKey(authorization);

      const res = await callWithKey(`Bearer ${prefix}_${"b".repeat(43)}`);

      expect(res.statusCode).toBe(401);
      expect((await keyRow(id)).lastUsedAt).toBeNull();
    });

    it("returns 401 for a merchant access token", async () => {
      const { authorization } = await merchantSession();

      expect((await callWithKey(authorization)).statusCode).toBe(401);
    });
  });

  it("never writes a plaintext key to the logs", async () => {
    const { authorization } = await merchantSession();
    const { id, key } = await createKey(authorization);
    await callWithKey(`Bearer ${key}`);
    await listKeys(authorization);
    await revokeKey(authorization, id);
    await callWithKey(`Bearer ${key}`);

    const logs = logLines.join("");
    // Make sure requests were actually logged, so the check below means something.
    expect(logs).toContain("/test/api-key-protected");
    expect(logs).not.toContain(key);
    expect(logs).not.toContain(parseApiKey(key)!.secret);
  });
});
