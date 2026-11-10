import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { buildApp } from "../src/app.js";
import { hashRefreshToken } from "../src/auth/refresh-tokens.js";
import { merchants, refreshTokens } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = "correct-horse-battery";
const uniqueEmail = () => `merchant-${randomUUID()}@example.com`;

describe("merchant auth", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const register = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/auth/register", payload: body });

  const login = (email: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });

  const me = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: "/v1/merchants/me",
      headers: authorization ? { authorization } : {},
    });

  const refresh = (refreshToken: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token: refreshToken },
    });

  const logout = (refreshToken: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token: refreshToken },
    });

  const tokenRow = async (refreshToken: string) => {
    const [row] = await app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
    return row!;
  };

  const familyRows = (familyId: string) =>
    app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));

  const registerMerchant = async () => {
    const email = uniqueEmail();
    const res = await register({ email, password: PASSWORD, name: "Duka" });
    expect(res.statusCode).toBe(201);
    return { email, id: res.json<{ id: string }>().id };
  };

  describe("POST /v1/auth/register", () => {
    it("creates a merchant and stores an argon2id hash", async () => {
      const email = uniqueEmail();

      const res = await register({ email, password: PASSWORD, name: " Duka " });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toEqual({
        id: expect.any(String),
        email,
        name: "Duka",
        created_at: expect.any(String),
      });
      expect(body).not.toHaveProperty("password_hash");

      const [row] = await app.db
        .select()
        .from(merchants)
        .where(eq(merchants.id, body.id));
      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row?.passwordHash).not.toContain(PASSWORD);
    });

    it("returns 409 for an existing email in any letter case", async () => {
      const { email } = await registerMerchant();

      const res = await register({
        email: email.toUpperCase(),
        password: PASSWORD,
        name: "Other",
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe(
        "An account with this email already exists",
      );
    });

    it.each([
      ["7 characters", "a".repeat(7)],
      ["129 characters", "a".repeat(129)],
    ])("rejects a password of %s with 400", async (_, password) => {
      const res = await register({ email: uniqueEmail(), password, name: "D" });

      expect(res.statusCode).toBe(400);
    });

    it.each([
      ["8 characters", "a".repeat(8)],
      ["128 characters", "a".repeat(128)],
    ])("accepts a password of %s", async (_, password) => {
      const res = await register({ email: uniqueEmail(), password, name: "D" });

      expect(res.statusCode).toBe(201);
    });

    it.each([
      [
        "an invalid email",
        { email: "not-an-email", password: PASSWORD, name: "D" },
      ],
      ["a missing name", { email: "a@example.com", password: PASSWORD }],
      [
        "a blank name",
        { email: "a@example.com", password: PASSWORD, name: "  " },
      ],
    ])("rejects %s with 400", async (_, body) => {
      const res = await register(body);

      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /v1/auth/login", () => {
    it("returns a 15-minute access token", async () => {
      const { email, id } = await registerMerchant();

      const res = await login(email.toUpperCase(), PASSWORD);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900 });

      const claims = app.jwt.decode<{ sub: string; iat: number; exp: number }>(
        body.access_token,
      );
      expect(claims?.sub).toBe(id);
      expect(claims!.exp - claims!.iat).toBe(900);
    });

    it("returns a 7-day refresh token stored only as a SHA-256 hash", async () => {
      const { email, id } = await registerMerchant();

      const body = (await login(email, PASSWORD)).json();

      expect(body.refresh_token).toEqual(expect.any(String));
      expect(body.refresh_expires_in).toBe(7 * 24 * 60 * 60);
      const row = await tokenRow(body.refresh_token);
      expect(row.merchantId).toBe(id);
      expect(row.tokenHash).not.toBe(body.refresh_token);
      expect(row.usedAt).toBeNull();
      expect(row.revokedAt).toBeNull();
      const ttlMs = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("starts a new token family on every login", async () => {
      const { email } = await registerMerchant();

      const first = (await login(email, PASSWORD)).json();
      const second = (await login(email, PASSWORD)).json();

      const [a, b] = await Promise.all([
        tokenRow(first.refresh_token),
        tokenRow(second.refresh_token),
      ]);
      expect(a.familyId).not.toBe(b.familyId);
    });

    it("returns the same 401 for a wrong password and an unknown email", async () => {
      const { email } = await registerMerchant();

      const wrongPassword = await login(email, "wrong-password");
      const unknownEmail = await login(uniqueEmail(), PASSWORD);

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual(unknownEmail.json());
      expect(wrongPassword.json().message).toBe("Invalid email or password");
    });
  });

  describe("protected routes", () => {
    it("return the merchant for a valid token", async () => {
      const { email, id } = await registerMerchant();
      const { access_token } = (await login(email, PASSWORD)).json();

      const res = await me(`Bearer ${access_token}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, email, name: "Duka" });
    });

    it("return 401 without a token", async () => {
      const res = await me();

      expect(res.statusCode).toBe(401);
    });

    it("return 401 for a tampered token", async () => {
      const { email } = await registerMerchant();
      const { access_token } = (await login(email, PASSWORD)).json();
      const [header, , signature] = access_token.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: randomUUID() }),
      ).toString("base64url");

      const res = await me(`Bearer ${header}.${forgedPayload}.${signature}`);

      expect(res.statusCode).toBe(401);
    });

    it("return 401 for a token signed with another secret", async () => {
      const other = await buildTestApp({
        JWT_SECRET: "another-secret-that-is-at-least-32-chars",
      });
      const { id } = await registerMerchant();
      const token = other.jwt.sign({ sub: id });
      await other.close();

      const res = await me(`Bearer ${token}`);

      expect(res.statusCode).toBe(401);
    });

    it("return 401 for an expired token", async () => {
      const { id } = await registerMerchant();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 16 * 60 * 1000);
      const token = app.jwt.sign({ sub: id });
      vi.useRealTimers();

      const res = await me(`Bearer ${token}`);

      expect(res.statusCode).toBe(401);
    });

    it("return 401 when the merchant no longer exists", async () => {
      const token = app.jwt.sign({ sub: randomUUID() });

      const res = await me(`Bearer ${token}`);

      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /v1/auth/refresh", () => {
    const loginFresh = async () => {
      const { email, id } = await registerMerchant();
      const body = (await login(email, PASSWORD)).json();
      return { id, refreshToken: body.refresh_token as string };
    };

    it("rotates the token within the same family", async () => {
      const { id, refreshToken } = await loginFresh();

      const res = await refresh(refreshToken);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        token_type: "Bearer",
        expires_in: 900,
        refresh_expires_in: 7 * 24 * 60 * 60,
      });
      expect(body.refresh_token).not.toBe(refreshToken);
      expect(app.jwt.decode<{ sub: string }>(body.access_token)?.sub).toBe(id);

      const [old, next] = await Promise.all([
        tokenRow(refreshToken),
        tokenRow(body.refresh_token),
      ]);
      expect(old.usedAt).not.toBeNull();
      expect(next.familyId).toBe(old.familyId);
      expect(next.usedAt).toBeNull();

      expect((await me(`Bearer ${body.access_token}`)).statusCode).toBe(200);
    });

    it("can be chained: each new token works once", async () => {
      const { refreshToken } = await loginFresh();

      const second = (await refresh(refreshToken)).json().refresh_token;
      const third = await refresh(second);

      expect(third.statusCode).toBe(200);
    });

    it("revokes the whole family, including the newest token, on reuse", async () => {
      const { refreshToken } = await loginFresh();
      const second = (await refresh(refreshToken)).json().refresh_token;
      const third = (await refresh(second)).json().refresh_token;

      const reuse = await refresh(refreshToken);

      expect(reuse.statusCode).toBe(401);
      const { familyId } = await tokenRow(refreshToken);
      const rows = await familyRows(familyId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect((await refresh(third)).statusCode).toBe(401);
    });

    it("issues exactly one new pair for concurrent refreshes of one token", async () => {
      const { refreshToken } = await loginFresh();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => refresh(refreshToken)),
      );

      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 401, 401, 401, 401]);
      const { familyId } = await tokenRow(refreshToken);
      expect(await familyRows(familyId)).toHaveLength(2);
    });

    it("returns 401 for an expired token without revoking the family", async () => {
      const { refreshToken } = await loginFresh();
      await app.db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));

      const res = await refresh(refreshToken);

      expect(res.statusCode).toBe(401);
      expect((await tokenRow(refreshToken)).revokedAt).toBeNull();
    });

    it("returns the same 401 for unknown, expired, revoked and reused tokens", async () => {
      const unknown = await refresh("not-a-real-token");
      const { refreshToken } = await loginFresh();
      await refresh(refreshToken);
      const reused = await refresh(refreshToken);
      const revoked = await refresh(refreshToken);

      expect(unknown.statusCode).toBe(401);
      expect(reused.json()).toEqual(unknown.json());
      expect(revoked.json()).toEqual(unknown.json());
      expect(unknown.json().message).toBe("Invalid refresh token");
    });

    it("rejects a missing refresh_token with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /v1/auth/logout", () => {
    it("revokes the family so its tokens can no longer refresh", async () => {
      const { email } = await registerMerchant();
      const first = (await login(email, PASSWORD)).json().refresh_token;
      const current = (await refresh(first)).json().refresh_token;

      const res = await logout(current);

      expect(res.statusCode).toBe(204);
      expect((await refresh(current)).statusCode).toBe(401);
      const { familyId } = await tokenRow(current);
      const rows = await familyRows(familyId);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it("leaves other sessions of the same merchant alive", async () => {
      const { email } = await registerMerchant();
      const phone = (await login(email, PASSWORD)).json().refresh_token;
      const laptop = (await login(email, PASSWORD)).json().refresh_token;

      await logout(phone);

      expect((await refresh(laptop)).statusCode).toBe(200);
    });

    it("returns 204 for an unknown token", async () => {
      const res = await logout("not-a-real-token");

      expect(res.statusCode).toBe(204);
    });
  });
});
