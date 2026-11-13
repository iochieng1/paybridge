import { isIP } from "node:net";

import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { webhookEndpoints } from "../db/schema.js";
import { isPrivateAddress } from "../webhooks/http.js";
import { encryptSecret, generateWebhookSecret } from "../webhooks/secrets.js";
import {
  accessTokenSecurity,
  accessTokenUnauthorized,
  errorResponse,
  validationError,
} from "./schemas.js";

const EXAMPLE_URL = "https://duka.co.ke/webhooks/paybridge";
const EXAMPLE_CREATED_AT = "2026-11-13T09:30:00.000Z";

const notFound = {
  statusCode: 404,
  error: "Not Found",
  message: "No webhook endpoint is set",
} as const;

const webhookEndpointRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);

  const { NODE_ENV, WEBHOOK_ALLOW_PRIVATE_URLS } = app.config;

  /**
   * Catches obvious mistakes when the URL is set. The real SSRF guard is at
   * delivery time, where every resolved address is checked.
   */
  const urlProblem = (url: URL) => {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "URL must be http or https";
    }
    if (NODE_ENV === "production" && url.protocol !== "https:") {
      return "URL must use https";
    }
    if (url.username || url.password) {
      return "URL must not contain credentials";
    }
    if (!WEBHOOK_ALLOW_PRIVATE_URLS) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        (isIP(host) !== 0 && isPrivateAddress(host))
      ) {
        return "URL must point at a public address";
      }
    }
    return undefined;
  };

  app.put(
    "",
    {
      schema: {
        summary: "Set the webhook endpoint",
        description:
          "PayBridge POSTs every final payment status (`payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.timed_out`) to this URL, signed with `X-PayBridge-Signature`. Returns the signing secret **once**. Calling it again replaces the URL and the secret; the old secret stops working immediately.",
        tags: ["webhooks"],
        security: accessTokenSecurity,
        body: z
          .object({
            url: z
              .url()
              .max(2048)
              .describe("Where to send webhooks; https in production"),
          })
          .meta({ example: { url: EXAMPLE_URL } }),
        response: {
          200: z
            .object({
              url: z.string(),
              secret: z
                .string()
                .describe(
                  "HMAC-SHA256 signing secret. Shown only now; store it securely.",
                ),
            })
            .describe("Endpoint set")
            .meta({
              example: {
                url: EXAMPLE_URL,
                secret: "whsec_example-secret-shown-only-once",
              },
            }),
          400: validationError,
          401: accessTokenUnauthorized,
          422: errorResponse("The URL can't be used for webhooks", {
            statusCode: 422,
            error: "Unprocessable Entity",
            message: "URL must point at a public address",
          }),
        },
      },
    },
    async (request, reply) => {
      const url = new URL(request.body.url);
      const problem = urlProblem(url);
      if (problem) {
        return reply.code(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message: problem,
        });
      }

      const secret = generateWebhookSecret();
      const secretEncrypted = encryptSecret(app.webhookEncryptionKey, secret);
      await app.db
        .insert(webhookEndpoints)
        .values({
          merchantId: request.merchant.id,
          url: url.href,
          secretEncrypted,
        })
        .onConflictDoUpdate({
          target: webhookEndpoints.merchantId,
          set: { url: url.href, secretEncrypted },
        });

      return { url: url.href, secret };
    },
  );

  app.get(
    "",
    {
      schema: {
        summary: "Get the webhook endpoint",
        description: "The signing secret can't be retrieved again.",
        tags: ["webhooks"],
        security: accessTokenSecurity,
        response: {
          200: z
            .object({ url: z.string(), created_at: z.iso.datetime() })
            .describe("The current endpoint")
            .meta({
              example: { url: EXAMPLE_URL, created_at: EXAMPLE_CREATED_AT },
            }),
          401: accessTokenUnauthorized,
          404: errorResponse("No endpoint is set", notFound),
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({
          url: webhookEndpoints.url,
          createdAt: webhookEndpoints.createdAt,
        })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.merchantId, request.merchant.id))
        .limit(1);
      if (!row) return reply.code(404).send(notFound);
      return { url: row.url, created_at: row.createdAt.toISOString() };
    },
  );

  app.delete(
    "",
    {
      schema: {
        summary: "Remove the webhook endpoint",
        description: "Webhooks not yet delivered are dropped.",
        tags: ["webhooks"],
        security: accessTokenSecurity,
        response: {
          204: z.undefined().describe("Endpoint removed"),
          401: accessTokenUnauthorized,
          404: errorResponse("No endpoint is set", notFound),
        },
      },
    },
    async (request, reply) => {
      const deleted = await app.db
        .delete(webhookEndpoints)
        .where(eq(webhookEndpoints.merchantId, request.merchant.id))
        .returning({ merchantId: webhookEndpoints.merchantId });
      if (deleted.length === 0) return reply.code(404).send(notFound);
      return reply.code(204).send();
    },
  );
};

export default webhookEndpointRoutes;
