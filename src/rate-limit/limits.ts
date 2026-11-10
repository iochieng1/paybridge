import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

import type { RateLimitOptions } from "./rate-limit.js";

const MINUTE_MS = 60_000;

// Keys hold hashes, not raw emails or API keys, so Redis never stores PII or secrets.
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Every request, per client IP. Fail-open: an outage shouldn't take the API down. */
export const globalLimit: RateLimitOptions = {
  key: (request) => `global:${request.ip}`,
  limit: 300,
  windowMs: MINUTE_MS,
  onRedisError: "allow",
};

/**
 * Login, per IP + email (runs as a preHandler so the body is parsed).
 * Fail-closed: without the limiter, passwords could be guessed at full speed.
 */
export const loginLimit: RateLimitOptions = {
  key: (request) => {
    const { email } = request.body as { email: string };
    return `login:${request.ip}:${sha256(email.trim().toLowerCase())}`;
  },
  limit: 5,
  windowMs: MINUTE_MS,
  onRedisError: "block",
};

/**
 * Payments, per API key. Fail-open: a Redis outage shouldn't stop merchants
 * taking money; idempotency keys still prevent duplicate charges.
 */
export const paymentsLimit = (
  apiKey: (request: FastifyRequest) => string | undefined,
): RateLimitOptions => ({
  key: (request) => {
    const value = apiKey(request);
    return value === undefined ? undefined : `payments:${sha256(value)}`;
  },
  limit: 60,
  windowMs: MINUTE_MS,
  onRedisError: "allow",
});
