import { z } from "zod";

/**
 * Fastify's error shape. `example` is copied into the OpenAPI document, so
 * every documented error response shows a realistic payload in /docs.
 */
export const errorResponse = (
  description: string,
  example: {
    statusCode: number;
    error: string;
    message: string;
    code?: string;
  },
) =>
  z
    .object({
      statusCode: z.number().int(),
      code: z.string().optional(),
      error: z.string(),
      message: z.string(),
    })
    .describe(description)
    .meta({ example });

export const validationError = errorResponse("Invalid request", {
  statusCode: 400,
  code: "FST_ERR_VALIDATION",
  error: "Bad Request",
  message: "body/email Invalid email address",
});

export const rateLimited = errorResponse("Rate limit exceeded", {
  statusCode: 429,
  error: "Too Many Requests",
  message: "Rate limit exceeded, retry later",
});

export const accessTokenUnauthorized = errorResponse(
  "Missing or invalid access token",
  {
    statusCode: 401,
    error: "Unauthorized",
    message: "Missing or invalid access token",
  },
);

export const apiKeyUnauthorized = errorResponse("Missing or invalid API key", {
  statusCode: 401,
  error: "Unauthorized",
  message: "Missing or invalid API key",
});

/** Security requirement for routes that take a merchant access token (JWT). */
export const accessTokenSecurity = [{ accessToken: [] }];

/** Security requirement for routes that take a merchant API key. */
export const apiKeySecurity = [{ apiKey: [] }];
