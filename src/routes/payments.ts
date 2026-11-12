import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { bearerToken } from "../auth/api-keys.js";
import { payments } from "../db/schema.js";
import { normalizePhone } from "../mpesa/phone.js";
import {
  claimIdempotencyKey,
  hashRequest,
  releaseIdempotencyKey,
  saveIdempotentResponse,
} from "../payments/idempotency.js";
import {
  createPayment,
  PAYMENT_STATUSES,
  PaymentCreationError,
  serializePayment,
} from "../payments/payments.js";
import { paymentsLimit } from "../rate-limit/limits.js";
import {
  apiKeySecurity,
  apiKeyUnauthorized,
  errorResponse,
  rateLimited,
  validationError,
} from "./schemas.js";

/** M-Pesa's maximum for a single transaction, in shillings. */
export const MAX_PAYMENT_AMOUNT = 250_000;

const EXAMPLE_ID = "5f0c2a8e-1b7d-4c3e-9f6a-2d8b4e1c7a90";
const EXAMPLE_CREATED_AT = "2026-11-11T09:30:00.000Z";

const examplePayment = {
  id: EXAMPLE_ID,
  status: "PENDING",
  amount: 1500,
  phone: "254712345678",
  reference: "INV-1001",
  description: "Order 1001",
  checkout_request_id: "ws_CO_111120260930001234567890",
  mpesa_receipt: null,
  result_code: null,
  result_desc: null,
  created_at: EXAMPLE_CREATED_AT,
  updated_at: EXAMPLE_CREATED_AT,
  completed_at: null,
} as const;

const paymentSchema = z.object({
  id: z.uuid(),
  status: z.enum(PAYMENT_STATUSES),
  amount: z.number().int().describe("Whole Kenyan shillings"),
  phone: z.string().describe("Normalised to 2547XXXXXXXX / 2541XXXXXXXX"),
  reference: z.string(),
  description: z.string(),
  checkout_request_id: z.string().nullable(),
  mpesa_receipt: z.string().nullable(),
  result_code: z.number().int().nullable(),
  result_desc: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
});

const createPaymentBody = z
  .object({
    phone: z
      .string()
      .refine(
        (value) => normalizePhone(value) !== undefined,
        "Must be a Kenyan mobile number, e.g. 0712345678",
      )
      .describe("Customer's M-Pesa number, in any common Kenyan format"),
    amount: z
      .number()
      .int("Amount must be whole shillings")
      .positive("Amount must be positive")
      .max(MAX_PAYMENT_AMOUNT)
      .describe("Whole Kenyan shillings"),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(12)
      .describe("Shown to the customer as the account number"),
    description: z.string().trim().min(1).max(13),
  })
  .meta({
    example: {
      phone: "0712345678",
      amount: 1500,
      reference: "INV-1001",
      description: "Order 1001",
    },
  });

// Loose, so the Authorization header survives validation.
const idempotencyHeaders = z.looseObject({
  "idempotency-key": z
    .string({ error: "Idempotency-Key header is required" })
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7E]+$/, "Must be printable ASCII without spaces")
    .describe(
      "Unique per payment attempt, e.g. a UUID. Retrying with the same key and body returns the original response instead of charging again. Keys are kept for 24 hours.",
    )
    .meta({ example: "order-1001-attempt-1" }),
});

const idParams = z.object({
  id: z.uuid().meta({ example: EXAMPLE_ID }),
});

const listQuery = z.object({
  status: z.enum(PAYMENT_STATUSES).optional().meta({ example: "SUCCEEDED" }),
  created_from: z.iso
    .datetime()
    .optional()
    .describe("Only payments created at or after this time")
    .meta({ example: "2026-11-01T00:00:00Z" }),
  created_to: z.iso
    .datetime()
    .optional()
    .describe("Only payments created before this time")
    .meta({ example: "2026-12-01T00:00:00Z" }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .meta({ example: 20 }),
  cursor: z
    .string()
    .optional()
    .describe("`next_cursor` from the previous page")
    .meta({ example: "WyIyMDI2LTExLTExVDA5OjMwOjAwLjAwMDAwMFoiLCI1ZjBjIl0" }),
});

const notFound = errorResponse("No such payment for this merchant", {
  statusCode: 404,
  error: "Not Found",
  message: "Payment not found",
});

const notFoundBody = {
  statusCode: 404,
  error: "Not Found",
  message: "Payment not found",
} as const;

/**
 * Cursors hold the last row's created_at as Postgres prints it (microseconds)
 * and its id. A JS Date only keeps milliseconds, which could skip or repeat
 * rows at page boundaries.
 */
const encodeCursor = (createdAt: string, id: string) =>
  Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");

const cursorSchema = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  z.uuid(),
]);

const decodeCursor = (cursor: string) => {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  // Limit per presented key before looking it up, then authenticate. Both run
  // before validation, so bad input from an unauthenticated caller gets 401.
  app.addHook("onRequest", app.rateLimit(paymentsLimit(bearerToken)));
  app.addHook("onRequest", app.apiKeyAuth);

  app.post(
    "",
    {
      schema: {
        summary: "Create a payment",
        description:
          "Sends an M-Pesa STK push to the customer's phone and returns `202` with the payment `PENDING`; the final status arrives by callback. The `Idempotency-Key` header is required: a retry with the same key and body replays the first response (with `Idempotent-Replayed: true`) and never sends a second push. If M-Pesa rejects the push, the payment is `FAILED` and the response is `502`.",
        tags: ["payments"],
        security: apiKeySecurity,
        headers: idempotencyHeaders,
        body: createPaymentBody,
        response: {
          202: paymentSchema
            .describe("STK push sent; waiting for the customer")
            .meta({ example: examplePayment }),
          400: validationError,
          401: apiKeyUnauthorized,
          409: errorResponse(
            "A request with this Idempotency-Key is still being processed",
            {
              statusCode: 409,
              error: "Conflict",
              message:
                "A request with this Idempotency-Key is still in progress; retry shortly",
            },
          ),
          422: errorResponse(
            "The Idempotency-Key was already used with a different body",
            {
              statusCode: 422,
              error: "Unprocessable Entity",
              message:
                "Idempotency-Key was already used with a different request body",
            },
          ),
          429: rateLimited,
          502: paymentSchema.describe("M-Pesa rejected the STK push").meta({
            example: {
              ...examplePayment,
              status: "FAILED",
              checkout_request_id: null,
              result_desc: "Invalid PhoneNumber",
              completed_at: EXAMPLE_CREATED_AT,
            },
          }),
        },
      },
    },
    async (request, reply) => {
      const merchantId = request.merchant.id;
      const key = request.headers["idempotency-key"];
      const input = request.body;
      const requestHash = hashRequest({
        phone: normalizePhone(input.phone)!,
        amount: input.amount,
        reference: input.reference,
        description: input.description,
      });

      const claim = await claimIdempotencyKey(
        app.db,
        merchantId,
        key,
        requestHash,
      );
      if (claim.kind === "replay") {
        reply.header("Idempotent-Replayed", "true");
        return reply
          .code(claim.status as 202 | 502)
          .send(claim.body as z.infer<typeof paymentSchema>);
      }
      if (claim.kind === "mismatch") {
        return reply.code(422).send({
          statusCode: 422,
          error: "Unprocessable Entity",
          message:
            "Idempotency-Key was already used with a different request body",
        });
      }
      if (claim.kind === "in_progress") {
        reply.header("Retry-After", 1);
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message:
            "A request with this Idempotency-Key is still in progress; retry shortly",
        });
      }

      let payment;
      try {
        payment = await createPayment(
          {
            db: app.db,
            daraja: app.daraja,
            publicBaseUrl: app.config.PUBLIC_BASE_URL,
          },
          merchantId,
          input,
        );
      } catch (err) {
        // Before Daraja was called it's safe to let the client retry. After,
        // the key stays claimed so a retry can't send a second push.
        if (err instanceof PaymentCreationError && !err.pushAttempted) {
          await releaseIdempotencyKey(app.db, merchantId, key).catch(
            (releaseErr: unknown) =>
              request.log.error(
                { err: releaseErr },
                "Failed to release idempotency key",
              ),
          );
        }
        throw err;
      }

      const status = payment.status === "FAILED" ? 502 : 202;
      const body = serializePayment(payment);
      try {
        await saveIdempotentResponse(app.db, merchantId, key, status, body);
      } catch (err) {
        // The payment exists; retries get 409 until the key expires, which
        // is safer than letting them push again.
        request.log.error(
          { err, paymentId: payment.id },
          "Failed to store idempotent response",
        );
      }
      return reply.code(status).send(body);
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        summary: "Get a payment",
        tags: ["payments"],
        security: apiKeySecurity,
        params: idParams,
        response: {
          200: paymentSchema
            .describe("The payment")
            .meta({ example: examplePayment }),
          400: validationError,
          401: apiKeyUnauthorized,
          404: notFound,
          429: rateLimited,
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.id, request.params.id),
            eq(payments.merchantId, request.merchant.id),
          ),
        )
        .limit(1);

      if (!row) return reply.code(404).send(notFoundBody);
      return serializePayment(row);
    },
  );

  app.get(
    "",
    {
      schema: {
        summary: "List payments",
        description:
          "Newest first, with optional status and creation-time filters. Pass `next_cursor` as `cursor` to get the next page; it is `null` on the last page.",
        tags: ["payments"],
        security: apiKeySecurity,
        querystring: listQuery,
        response: {
          200: z
            .object({
              data: z.array(paymentSchema),
              next_cursor: z.string().nullable(),
            })
            .describe("A page of payments")
            .meta({
              example: { data: [examplePayment], next_cursor: null },
            }),
          400: validationError,
          401: apiKeyUnauthorized,
          429: rateLimited,
        },
      },
    },
    async (request, reply) => {
      const { status, created_from, created_to, limit, cursor } = request.query;

      const conditions: SQL[] = [eq(payments.merchantId, request.merchant.id)];
      if (status) conditions.push(eq(payments.status, status));
      if (created_from) {
        conditions.push(gte(payments.createdAt, new Date(created_from)));
      }
      if (created_to) {
        conditions.push(lt(payments.createdAt, new Date(created_to)));
      }
      if (cursor !== undefined) {
        const position = decodeCursor(cursor);
        if (!position) {
          return reply.code(400).send({
            statusCode: 400,
            code: "FST_ERR_VALIDATION",
            error: "Bad Request",
            message: "querystring/cursor Invalid cursor",
          });
        }
        const [createdAt, id] = position;
        conditions.push(
          sql`(${payments.createdAt}, ${payments.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
        );
      }

      const rows = await app.db
        .select({
          payment: payments,
          cursorCreatedAt: sql<string>`to_char(${payments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(payments)
        .where(and(...conditions))
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        data: page.map((row) => serializePayment(row.payment)),
        next_cursor:
          rows.length > limit && last
            ? encodeCursor(last.cursorCreatedAt, last.payment.id)
            : null,
      };
    },
  );
};

export default paymentRoutes;
