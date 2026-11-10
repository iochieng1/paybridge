import { sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import {
  hashPassword,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../auth/password.js";
import {
  issueRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
} from "../auth/refresh-tokens.js";
import { merchants } from "../db/schema.js";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const email = { type: "string", format: "email", maxLength: 254 } as const;

type RegisterBody = { email: string; password: string; name: string };
type LoginBody = { email: string; password: string };
type RefreshBody = { refresh_token: string };

const refreshBodySchema = {
  type: "object",
  required: ["refresh_token"],
  additionalProperties: false,
  properties: {
    refresh_token: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  // postgres.js reports SQLSTATE in `code`; Drizzle wraps it in `cause`.
  const { code, cause } = err as { code?: unknown; cause?: unknown };
  return code === "23505" || isUniqueViolation(cause);
};

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RegisterBody }>(
    "/register",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password", "name"],
          additionalProperties: false,
          properties: {
            email,
            password: { type: "string", minLength: 8, maxLength: 128 },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              pattern: "\\S",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { password } = request.body;
      const passwordHash = await hashPassword(password);

      try {
        const [merchant] = await app.db
          .insert(merchants)
          .values({
            email: request.body.email.toLowerCase(),
            name: request.body.name.trim(),
            passwordHash,
          })
          .returning({
            id: merchants.id,
            email: merchants.email,
            name: merchants.name,
            createdAt: merchants.createdAt,
          });

        return reply.code(201).send({
          id: merchant!.id,
          email: merchant!.email,
          name: merchant!.name,
          created_at: merchant!.createdAt.toISOString(),
        });
      } catch (err) {
        // merchants_email_lower_idx makes this race-safe and case-insensitive.
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            statusCode: 409,
            error: "Conflict",
            message: "An account with this email already exists",
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Body: LoginBody }>(
    "/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          additionalProperties: false,
          properties: {
            email: { type: "string", minLength: 1, maxLength: 254 },
            password: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { password } = request.body;

      const [merchant] = await app.db
        .select({ id: merchants.id, passwordHash: merchants.passwordHash })
        .from(merchants)
        .where(sql`lower(${merchants.email}) = lower(${request.body.email})`)
        .limit(1);

      const valid = merchant
        ? await verifyPassword(merchant.passwordHash, password)
        : await verifyAgainstDummyHash(password);

      if (!merchant || !valid) {
        // Same status and message for both cases so emails can't be enumerated.
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Invalid email or password",
        });
      }

      const refreshToken = await issueRefreshToken(app.db, merchant.id);
      return reply.send(await tokenPair(reply, merchant.id, refreshToken));
    },
  );

  app.post<{ Body: RefreshBody }>(
    "/refresh",
    { schema: { body: refreshBodySchema } },
    async (request, reply) => {
      const result = await rotateRefreshToken(
        app.db,
        request.body.refresh_token,
      );

      if (!result.ok) {
        if (result.reason === "reused") {
          request.log.warn(
            "Refresh token reuse detected; token family revoked",
          );
        }
        // One response for every failure, so callers learn nothing about why.
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Invalid refresh token",
        });
      }

      return reply.send(
        await tokenPair(reply, result.merchantId, result.refreshToken),
      );
    },
  );

  app.post<{ Body: RefreshBody }>(
    "/logout",
    { schema: { body: refreshBodySchema } },
    async (request, reply) => {
      await revokeRefreshTokenFamily(app.db, request.body.refresh_token);
      // 204 even for unknown tokens: logout is idempotent and not an oracle.
      return reply.code(204).send();
    },
  );
};

const tokenPair = async (
  reply: FastifyReply,
  merchantId: string,
  refreshToken: string,
) => ({
  access_token: await reply.jwtSign({ sub: merchantId }),
  token_type: "Bearer",
  expires_in: ACCESS_TOKEN_TTL_SECONDS,
  refresh_token: refreshToken,
  refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
});

export default authRoutes;
