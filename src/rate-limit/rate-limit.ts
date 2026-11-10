import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis, Result } from "ioredis";

/**
 * Sliding-window log, atomically: drop entries older than the window, count
 * what's left, and record this request only if it fits. Rejected requests are
 * not recorded, so a client that keeps retrying still recovers once old
 * entries age out.
 *
 * Returns { allowed (1/0), remaining, retryAfterMs }.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    slidingWindow(
      key: string,
      now: number,
      windowMs: number,
      limit: number,
      member: string,
    ): Result<[number, number, number], Context>;
  }
}

export type RateLimitOptions = {
  /** Identifies the bucket; return undefined to skip limiting this request. */
  key: (request: FastifyRequest) => string | undefined;
  limit: number;
  windowMs: number;
  /** "allow" = fail-open, "block" = fail-closed when Redis is unavailable. */
  onRedisError: "allow" | "block";
};

export type RateLimitHook = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    rateLimit: (options: RateLimitOptions) => RateLimitHook;
  }
}

/**
 * Returns a factory for hooks usable as `onRequest` or `preHandler` (use
 * preHandler when the key needs the parsed body). Every key is namespaced
 * under `prefix`.
 */
export const createRateLimit = (redis: Redis, prefix: string) => {
  redis.defineCommand("slidingWindow", {
    numberOfKeys: 1,
    lua: SLIDING_WINDOW_LUA,
  });

  return ({
      key,
      limit,
      windowMs,
      onRedisError,
    }: RateLimitOptions): RateLimitHook =>
    async (request, reply) => {
      const id = key(request);
      if (id === undefined) return;

      const now = Date.now();
      let allowed: number, remaining: number, retryAfterMs: number;
      try {
        [allowed, remaining, retryAfterMs] = await redis.slidingWindow(
          `${prefix}:${id}`,
          now,
          windowMs,
          limit,
          `${now}:${randomUUID()}`,
        );
      } catch (err) {
        if (onRedisError === "allow") {
          request.log.warn(
            { err, rateLimitKey: id },
            "Rate limiter unavailable; allowing request (fail-open)",
          );
          return;
        }
        request.log.warn(
          { err, rateLimitKey: id },
          "Rate limiter unavailable; blocking request (fail-closed)",
        );
        return reply.code(503).send({
          statusCode: 503,
          error: "Service Unavailable",
          message: "Temporarily unavailable, please try again shortly",
        });
      }

      reply.header("RateLimit-Limit", limit);
      reply.header("RateLimit-Remaining", remaining);

      if (!allowed) {
        reply.header(
          "Retry-After",
          Math.max(1, Math.ceil(retryAfterMs / 1000)),
        );
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Rate limit exceeded, retry later",
        });
      }
    };
};
