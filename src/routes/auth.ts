import { sql } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

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
import { isUniqueViolation } from "../db/errors.js";
import { merchants } from "../db/schema.js";
import { loginLimit } from "../rate-limit/limits.js";
import { errorResponse, rateLimited, validationError } from "./schemas.js";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const tokenPairResponse = z
  .object({
    access_token: z.string(),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().describe("Access token lifetime in seconds"),
    refresh_token: z.string(),
    refresh_expires_in: z
      .number()
      .int()
      .describe("Refresh token lifetime in seconds"),
  })
  .describe("A new access token and refresh token")
  .meta({
    example: {
      access_token:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1ZjBjLi4uIn0.c2lnbmF0dXJl",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: "q0vP3n9yX2pZ8mR4tL6wK1sD5fG7hJ0aB3cE6iO9uY2",
      refresh_expires_in: 604800,
    },
  });

const refreshBody = z
  .object({ refresh_token: z.string().min(1).max(128) })
  .strict()
  .meta({
    example: { refresh_token: "q0vP3n9yX2pZ8mR4tL6wK1sD5fG7hJ0aB3cE6iO9uY2" },
  });

const invalidRefreshToken = errorResponse("Invalid refresh token", {
  statusCode: 401,
  error: "Unauthorized",
  message: "Invalid refresh token",
});

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/register",
    {
      schema: {
        summary: "Register a merchant",
        tags: ["auth"],
        body: z
          .object({
            email: z.email().max(254),
            password: z.string().min(8).max(128),
            name: z.string().min(1).max(100).regex(/\S/, "Must not be blank"),
          })
          .strict()
          .meta({
            example: {
              email: "owner@duka.co.ke",
              password: "correct-horse-battery",
              name: "Duka Ltd",
            },
          }),
        response: {
          201: z
            .object({
              id: z.uuid(),
              email: z.string(),
              name: z.string(),
              created_at: z.iso.datetime(),
            })
            .describe("Merchant created")
            .meta({
              example: {
                id: "5f0c6a3e-8b1d-4c2a-9e7f-1a2b3c4d5e6f",
                email: "owner@duka.co.ke",
                name: "Duka Ltd",
                created_at: "2026-11-11T09:30:00.000Z",
              },
            }),
          400: validationError,
          409: errorResponse("Email already registered", {
            statusCode: 409,
            error: "Conflict",
            message: "An account with this email already exists",
          }),
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

  app.post(
    "/login",
    {
      preHandler: app.rateLimit(loginLimit),
      schema: {
        summary: "Log in and get an access token and refresh token",
        tags: ["auth"],
        body: z
          .object({
            email: z.string().min(1).max(254),
            password: z.string().min(1).max(128),
          })
          .strict()
          .meta({
            example: {
              email: "owner@duka.co.ke",
              password: "correct-horse-battery",
            },
          }),
        response: {
          200: tokenPairResponse,
          400: validationError,
          401: errorResponse("Invalid email or password", {
            statusCode: 401,
            error: "Unauthorized",
            message: "Invalid email or password",
          }),
          429: rateLimited,
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

  app.post(
    "/refresh",
    {
      schema: {
        summary: "Rotate a refresh token",
        description:
          "Each refresh token works once. Reusing one revokes every token from the same login.",
        tags: ["auth"],
        body: refreshBody,
        response: {
          200: tokenPairResponse,
          400: validationError,
          401: invalidRefreshToken,
        },
      },
    },
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

  app.post(
    "/logout",
    {
      schema: {
        summary: "Log out (revoke the refresh token's session)",
        tags: ["auth"],
        body: refreshBody,
        response: {
          204: z.undefined().describe("Logged out (also for unknown tokens)"),
          400: validationError,
        },
      },
    },
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
  token_type: "Bearer" as const,
  expires_in: ACCESS_TOKEN_TTL_SECONDS,
  refresh_token: refreshToken,
  refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
});

export default authRoutes;
