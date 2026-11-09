import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { buildApp } from "../src/app.js";
import { merchants } from "../src/db/schema.js";
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
});
