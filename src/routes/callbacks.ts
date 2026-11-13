import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  applyStkCallback,
  findPaymentByCallbackToken,
} from "../payments/callbacks.js";
import { errorResponse, rateLimited, validationError } from "./schemas.js";

const EXAMPLE_TOKEN = "example-callback-token-from-the-payment-url";

const stkCallbackBody = z
  .object({
    Body: z.object({
      stkCallback: z.object({
        MerchantRequestID: z.string(),
        CheckoutRequestID: z.string(),
        ResultCode: z.coerce.number().int(),
        ResultDesc: z.string(),
        CallbackMetadata: z
          .object({
            Item: z.array(
              z.object({
                Name: z.string(),
                Value: z.union([z.string(), z.number()]).optional(),
              }),
            ),
          })
          .optional(),
      }),
    }),
  })
  .meta({
    example: {
      Body: {
        stkCallback: {
          MerchantRequestID: "29115-34620561-1",
          CheckoutRequestID: "ws_CO_111120260930001234567890",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 1500 },
              { Name: "MpesaReceiptNumber", Value: "TKB4XYZ123" },
              { Name: "TransactionDate", Value: 20261111093512 },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    },
  });

/** What Daraja expects back. Anything else may make it redeliver. */
const accepted = { ResultCode: 0, ResultDesc: "Accepted" } as const;

const callbackRoutes: FastifyPluginAsyncZod = async (app) => {
  const allowlist = new Set(app.config.MPESA_CALLBACK_IP_ALLOWLIST);

  app.post(
    "/mpesa/:token",
    {
      schema: {
        summary: "Receive an M-Pesa STK callback",
        description:
          "Called by Safaricom, not by merchants. The URL carries the payment's secret callback token. Duplicate and late callbacks are acknowledged and ignored; a callback whose data doesn't match the payment is confirmed with STK Push Query before it changes anything.",
        tags: ["callbacks"],
        params: z.object({
          token: z.string().max(128).meta({ example: EXAMPLE_TOKEN }),
        }),
        body: stkCallbackBody,
        response: {
          200: z
            .object({ ResultCode: z.literal(0), ResultDesc: z.string() })
            .describe("Callback received (including duplicates)")
            .meta({ example: accepted }),
          400: validationError,
          403: errorResponse("The caller's IP isn't on the allowlist", {
            statusCode: 403,
            error: "Forbidden",
            message: "Callback source not allowed",
          }),
          404: errorResponse("No payment has this callback token", {
            statusCode: 404,
            error: "Not Found",
            message: "Unknown callback",
          }),
          429: rateLimited,
          503: errorResponse(
            "The callback needs verifying and M-Pesa couldn't be reached; it can be redelivered",
            {
              statusCode: 503,
              error: "Service Unavailable",
              message: "Could not verify the callback, please retry",
            },
          ),
        },
      },
    },
    async (request, reply) => {
      if (allowlist.size > 0 && !allowlist.has(request.ip)) {
        request.log.warn(
          { ip: request.ip },
          "Rejected M-Pesa callback from an IP not on the allowlist",
        );
        return reply.code(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Callback source not allowed",
        });
      }

      const payment = await findPaymentByCallbackToken(
        app.db,
        request.params.token,
      );
      if (!payment) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Unknown callback",
        });
      }

      const outcome = await applyStkCallback(
        { db: app.db, daraja: app.daraja },
        payment,
        request.body.Body.stkCallback,
      );
      const log = request.log.child({ paymentId: payment.id });

      switch (outcome.kind) {
        case "applied":
          log.info(
            {
              status: outcome.payment.status,
              verifiedByQuery: outcome.verifiedByQuery,
            },
            "Applied M-Pesa callback",
          );
          await app.jobs.notifyPaymentFinal(outcome.payment);
          return accepted;
        case "ignored":
          log.info("Ignored duplicate or late M-Pesa callback");
          return accepted;
        case "unverified":
          log.warn(
            { problems: outcome.problems },
            "M-Pesa callback didn't match the payment and STK Push Query says it's still pending; left unchanged",
          );
          return accepted;
        case "verification_failed":
          log.error(
            { problems: outcome.problems, err: outcome.error },
            "Could not verify a suspicious M-Pesa callback",
          );
          return reply.code(503).send({
            statusCode: 503,
            error: "Service Unavailable",
            message: "Could not verify the callback, please retry",
          });
      }
    },
  );
};

export default callbackRoutes;
