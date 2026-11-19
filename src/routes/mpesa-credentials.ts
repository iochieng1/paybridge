import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { isUniqueViolation } from "../db/errors.js";
import { mpesaCredentials } from "../db/schema.js";
import { serializeMpesaCredentials } from "../mpesa/credentials.js";
import { DarajaError } from "../mpesa/daraja.js";
import {
  accessTokenSecurity,
  accessTokenUnauthorized,
  errorResponse,
  validationError,
} from "./schemas.js";

const EXAMPLE = {
  id: "0b6f3c1e-5d2a-4f7e-9c41-2a8d7e6b5f10",
  shortcode: "600123",
  type: "paybill",
  till_number: null,
  consumer_key: "••••x7Qa",
  created_at: "2026-11-18T09:30:00.000Z",
} as const;

const shortcode = z.string().regex(/^\d{5,7}$/, "Must be a 5-7 digit number");

const credentialsBody = z
  .object({
    shortcode: shortcode.describe(
      "The paybill number, or for a till its store (head office) number",
    ),
    type: z.enum(["paybill", "till"]),
    till_number: shortcode
      .optional()
      .describe("For a till: the number customers pay to"),
    consumer_key: z.string().trim().min(8).max(256),
    consumer_secret: z.string().trim().min(8).max(256),
    passkey: z
      .string()
      .trim()
      .min(8)
      .max(256)
      .describe("Lipa na M-Pesa Online passkey for the shortcode"),
  })
  .refine(
    (body) => (body.type === "till") === (body.till_number !== undefined),
    {
      message: "till_number is required for a till, and only for a till",
      path: ["till_number"],
    },
  )
  .meta({
    example: {
      shortcode: "600123",
      type: "paybill",
      consumer_key: "your-daraja-consumer-key",
      consumer_secret: "your-daraja-consumer-secret",
      passkey: "your-lipa-na-mpesa-passkey",
    },
  });

const credentialsSchema = z
  .object({
    id: z.uuid(),
    shortcode: z.string(),
    type: z.enum(["paybill", "till"]),
    till_number: z.string().nullable(),
    consumer_key: z.string().describe("Masked: only the last 4 characters"),
    created_at: z.iso.datetime(),
  })
  .meta({ example: EXAMPLE });

const notFound = {
  statusCode: 404,
  error: "Not Found",
  message: "No M-Pesa credentials are connected",
} as const;

const mpesaCredentialsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);

  const active = (merchantId: string) =>
    and(
      eq(mpesaCredentials.merchantId, merchantId),
      isNull(mpesaCredentials.revokedAt),
    );

  app.put(
    "",
    {
      schema: {
        summary: "Connect your M-Pesa paybill or till",
        description:
          "Payments are then sent to this shortcode, so money goes straight to the merchant and never through PayBridge. The consumer key and secret are checked with Daraja before they're saved; the passkey can only be checked by a real payment. Secrets are stored encrypted and never returned. Calling it again replaces the credentials: new payments use the new ones, and payments still open finish with the ones they were created with.",
        tags: ["mpesa"],
        security: accessTokenSecurity,
        body: credentialsBody,
        response: {
          200: credentialsSchema.describe("Credentials connected"),
          400: validationError,
          401: accessTokenUnauthorized,
          409: errorResponse("Another request is changing the credentials", {
            statusCode: 409,
            error: "Conflict",
            message:
              "The credentials were changed by another request; try again",
          }),
          422: errorResponse("Daraja rejected the consumer key and secret", {
            statusCode: 422,
            error: "Unprocessable Entity",
            message:
              "Daraja rejected this consumer key and secret: Invalid Authentication passed",
          }),
          502: errorResponse("Daraja couldn't be reached to check them", {
            statusCode: 502,
            error: "Bad Gateway",
            message:
              "Couldn't reach M-Pesa to check the credentials; try again",
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const input = {
        shortcode: body.shortcode,
        shortcodeType: body.type,
        tillNumber: body.till_number,
        consumerKey: body.consumer_key,
        consumerSecret: body.consumer_secret,
        passkey: body.passkey,
      };

      try {
        await app.mpesa.verify(input);
      } catch (err) {
        if (!(err instanceof DarajaError)) throw err;
        const status = err.details.status;
        // Daraja answers bad credentials with a 400 or 401.
        if (status !== undefined && status >= 400 && status < 500) {
          return reply.code(422).send({
            statusCode: 422,
            error: "Unprocessable Entity",
            message: `Daraja rejected this consumer key and secret: ${err.message}`,
          });
        }
        request.log.warn({ err }, "Couldn't verify M-Pesa credentials");
        return reply.code(502).send({
          statusCode: 502,
          error: "Bad Gateway",
          message: "Couldn't reach M-Pesa to check the credentials; try again",
        });
      }

      const merchantId = request.merchant.id;
      try {
        const row = await app.db.transaction(async (tx) => {
          await tx
            .update(mpesaCredentials)
            .set({ revokedAt: new Date() })
            .where(active(merchantId));
          const [inserted] = await tx
            .insert(mpesaCredentials)
            .values({ merchantId, ...app.mpesa.encrypt(input) })
            .returning();
          return inserted!;
        });
        request.log.info(
          { credentialsId: row.id, shortcode: row.shortcode },
          "Connected M-Pesa credentials",
        );
        return serializeMpesaCredentials(row);
      } catch (err) {
        // Two concurrent requests both revoked the old set; one insert wins.
        if (!isUniqueViolation(err)) throw err;
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "The credentials were changed by another request; try again",
        });
      }
    },
  );

  app.get(
    "",
    {
      schema: {
        summary: "Get the connected M-Pesa credentials",
        description: "Secrets are never returned; the consumer key is masked.",
        tags: ["mpesa"],
        security: accessTokenSecurity,
        response: {
          200: credentialsSchema.describe("The credentials in use"),
          401: accessTokenUnauthorized,
          404: errorResponse("None are connected", notFound),
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(mpesaCredentials)
        .where(active(request.merchant.id))
        .limit(1);
      if (!row) return reply.code(404).send(notFound);
      return serializeMpesaCredentials(row);
    },
  );

  app.delete(
    "",
    {
      schema: {
        summary: "Disconnect the M-Pesa credentials",
        description:
          "New payments can't be taken until credentials are connected again (in the sandbox they fall back to PayBridge's test shortcode). Payments still open finish with the removed credentials.",
        tags: ["mpesa"],
        security: accessTokenSecurity,
        response: {
          204: z.undefined().describe("Disconnected"),
          401: accessTokenUnauthorized,
          404: errorResponse("None are connected", notFound),
        },
      },
    },
    async (request, reply) => {
      const revoked = await app.db
        .update(mpesaCredentials)
        .set({ revokedAt: new Date() })
        .where(active(request.merchant.id))
        .returning({ id: mpesaCredentials.id });
      if (revoked.length === 0) return reply.code(404).send(notFound);
      return reply.code(204).send();
    },
  );
};

export default mpesaCredentialsRoutes;
