import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { generateApiKey } from "../auth/api-keys.js";
import { isUniqueViolation } from "../db/errors.js";
import { apiKeys } from "../db/schema.js";
import {
  accessTokenSecurity,
  accessTokenUnauthorized,
  errorResponse,
  validationError,
} from "./schemas.js";

const EXAMPLE_ID = "0b7e1c52-3f4a-4d8e-9a61-2c5d8f9e0a1b";
const EXAMPLE_PREFIX = "pb_test_3f9a1c0b7e2d";
const EXAMPLE_CREATED_AT = "2026-11-11T09:30:00.000Z";

const prefix = z
  .string()
  .describe(
    "Public part of the key, safe to display. The secret is never shown again.",
  );

const apiKeyItem = z.object({
  id: z.uuid(),
  prefix,
  created_at: z.iso.datetime(),
  last_used_at: z.iso.datetime().nullable(),
});

const idParams = z.object({
  id: z.uuid().meta({ example: EXAMPLE_ID }),
});

const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post(
    "",
    {
      schema: {
        summary: "Create an API key",
        description:
          "Returns the full key **once**. Store it securely: only its prefix and a hash are kept.",
        tags: ["api-keys"],
        security: accessTokenSecurity,
        response: {
          201: z
            .object({
              id: z.uuid(),
              prefix,
              key: z
                .string()
                .describe(
                  "The full API key. Send it as `Authorization: Bearer <key>`.",
                ),
              created_at: z.iso.datetime(),
            })
            .describe("API key created")
            .meta({
              example: {
                id: EXAMPLE_ID,
                prefix: EXAMPLE_PREFIX,
                key: `${EXAMPLE_PREFIX}_Xq2v9LkP0aZ7rT4mN8bW1cY5dF3gH6jS0eU2iO4pQ7w`,
                created_at: EXAMPLE_CREATED_AT,
              },
            }),
          401: accessTokenUnauthorized,
        },
      },
    },
    async (request, reply) => {
      // 48-bit prefixes make a collision very unlikely; retry if one happens.
      for (let attempt = 1; ; attempt++) {
        const { prefix, key, keyHash } = generateApiKey();
        try {
          const [row] = await app.db
            .insert(apiKeys)
            .values({ merchantId: request.merchant.id, prefix, keyHash })
            .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });

          return reply.code(201).send({
            id: row!.id,
            prefix,
            key,
            created_at: row!.createdAt.toISOString(),
          });
        } catch (err) {
          if (attempt >= 3 || !isUniqueViolation(err)) throw err;
        }
      }
    },
  );

  app.get(
    "",
    {
      schema: {
        summary: "List active API keys",
        description:
          "Shows each key's prefix only; secrets can't be retrieved.",
        tags: ["api-keys"],
        security: accessTokenSecurity,
        response: {
          200: z
            .object({ data: z.array(apiKeyItem) })
            .describe("Active API keys, newest first")
            .meta({
              example: {
                data: [
                  {
                    id: EXAMPLE_ID,
                    prefix: EXAMPLE_PREFIX,
                    created_at: EXAMPLE_CREATED_AT,
                    last_used_at: "2026-11-11T10:02:17.000Z",
                  },
                ],
              },
            }),
          401: accessTokenUnauthorized,
        },
      },
    },
    async (request) => {
      const rows = await app.db
        .select({
          id: apiKeys.id,
          prefix: apiKeys.prefix,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.merchantId, request.merchant.id),
            isNull(apiKeys.revokedAt),
          ),
        )
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));

      return {
        data: rows.map((row) => ({
          id: row.id,
          prefix: row.prefix,
          created_at: row.createdAt.toISOString(),
          last_used_at: row.lastUsedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        summary: "Revoke an API key",
        description:
          "Requests using the key get `401` immediately. Revoking an already revoked key is a no-op.",
        tags: ["api-keys"],
        security: accessTokenSecurity,
        params: idParams,
        response: {
          204: z.undefined().describe("API key revoked"),
          400: validationError,
          401: accessTokenUnauthorized,
          404: errorResponse("No such API key for this merchant", {
            statusCode: 404,
            error: "Not Found",
            message: "API key not found",
          }),
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .update(apiKeys)
        // coalesce keeps the original revocation time on repeat calls.
        .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
        .where(
          and(
            eq(apiKeys.id, request.params.id),
            eq(apiKeys.merchantId, request.merchant.id),
          ),
        )
        .returning({ id: apiKeys.id });

      if (!row) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "API key not found",
        });
      }
      return reply.code(204).send();
    },
  );
};

export default apiKeyRoutes;
