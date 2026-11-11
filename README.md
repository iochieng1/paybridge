# PayBridge

[![CI](https://github.com/iochieng1/paybridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iochieng1/paybridge/actions/workflows/ci.yml)

**An M-Pesa payments gateway API that is rate-limited, idempotent, and can't double-credit a payment.**

> 🚧 Work in progress. Day 1 of 10: scaffold, database schema, health checks, CI.
>
> <!-- TODO: demo GIF here once payments work (day 10) -->
>
> **Live API:** _coming soon_ · **Docs:** `/docs` (Swagger UI) · `/openapi.json`

PayBridge lets any app accept M-Pesa payments through one clean REST API. It deals with the messy parts of Safaricom's Daraja API: STK push timeouts, duplicate callbacks, unsigned webhooks and token expiry. You don't have to.

The public demo runs against the **Daraja sandbox**. No real money moves.

## Features (roadmap)

- [x] Fastify + TypeScript service with validated config and graceful shutdown
- [x] PostgreSQL schema and migrations for merchants, tokens, API keys, payments, audit log, idempotency and webhooks
- [x] `/health` endpoint that checks Postgres and Redis
- [x] CI: lint, format, typecheck, migration drift check, integration tests on real Postgres/Redis, secret scanning
- [x] Merchant registration and login (argon2id passwords, 15-minute access JWT)
- [x] Refresh-token rotation and reuse detection
- [x] Redis sliding-window rate limiter (atomic Lua script)
- [x] API keys and OpenAPI/Swagger docs
- [ ] STK push payments with `Idempotency-Key` support
- [ ] Callback handling with deduplication and a forward-only state machine
- [ ] Reconciliation job for lost callbacks (STK Push Query)
- [ ] HMAC-signed merchant webhooks with exponential-backoff retries

## Quick start

Requires Node 24 (`nvm use`) and Docker.

```bash
npm install
cp .env.example .env
docker compose up -d     # Postgres + Redis
npm run db:migrate
npm run dev              # http://localhost:3000/health
```

Then open http://localhost:3000/docs for the interactive API reference.

## Authentication

There are two kinds of credentials:

| Who                | Credential                                                       | Used for                                |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------- |
| A merchant (human) | Access token from `POST /v1/auth/login` (15 min) + refresh token | Dashboard routes such as `/v1/api-keys` |
| A merchant server  | API key `pb_test_<prefix>_<secret>` from `POST /v1/api-keys`     | Payment routes                          |

Both are sent as `Authorization: Bearer <token>`.

```bash
# Create an API key (the full key is shown once; store it somewhere safe)
curl -X POST http://localhost:3000/v1/api-keys -H "Authorization: Bearer $ACCESS_TOKEN"

# List keys (prefixes only) and revoke one
curl http://localhost:3000/v1/api-keys -H "Authorization: Bearer $ACCESS_TOKEN"
curl -X DELETE http://localhost:3000/v1/api-keys/$KEY_ID -H "Authorization: Bearer $ACCESS_TOKEN"
```

## Scripts

| Command                              | What it does                                                   |
| ------------------------------------ | -------------------------------------------------------------- |
| `npm run dev`                        | Start the API with hot reload                                  |
| `npm test`                           | Integration tests (starts throwaway Postgres/Redis containers) |
| `npm run lint` / `npm run typecheck` | Static checks                                                  |
| `npm run db:generate`                | Generate a SQL migration after editing `src/db/schema.ts`      |
| `npm run db:migrate`                 | Apply migrations to `DATABASE_URL`                             |
| `npm run build && npm start`         | Production build; `start` applies migrations, then boots       |

## Project structure

```
src/
  app.ts            # Fastify app factory (used by server and tests)
  server.ts         # Entry point: listen + graceful shutdown
  config.ts         # zod-validated environment variables
  db/
    schema.ts       # Drizzle schema (source of truth)
    client.ts       # Postgres connection
    migrate.ts      # Migration runner
  openapi.ts        # OpenAPI document (/openapi.json) and Swagger UI (/docs)
  auth/             # Passwords, access/refresh tokens, API keys
  rate-limit/       # Sliding-window limiter (Lua) and the configured limits
  routes/           # HTTP routes with zod request/response schemas
drizzle/            # Generated SQL migrations (committed)
test/               # Vitest + Testcontainers integration tests
```

## Trade-offs

Decisions and the reasons for them. This section grows as features land.

- **PostgreSQL over MongoDB.** Payments need ACID transactions, unique constraints (`checkout_request_id`, `mpesa_receipt`) for deduplication, and conditional updates for the state machine.
- **Amounts as integers.** Daraja accepts only whole shillings, so there is no floating-point money anywhere.
- **Tests run against real Postgres and Redis (Testcontainers), not mocks.** The guarantees this service makes come from database constraints, row locks and Redis Lua scripts. Mocks would test none of them.
- **Migrations run on start-up.** On a single-instance free-tier deploy, this guarantees the schema matches the code. With multiple instances it would move to a separate release step.
- **argon2id for passwords.** It is memory-hard, which makes GPU cracking expensive. Parameters follow OWASP (19 MiB, 2 iterations, 1 lane).
- **Login doesn't reveal which emails exist.** A wrong email and a wrong password get the same `401` and message. For an unknown email, login still runs a full argon2 verification against a dummy hash, so response times match too.
- **Short-lived stateless access tokens.** Access JWTs (HS256) last 15 minutes and aren't stored, so verifying one needs no database lookup for the token itself. Revocation comes from refresh-token rotation: once a session is revoked, its access token stops working within 15 minutes.
- **Refresh tokens rotate on every use.** Login returns a 7-day refresh token. `POST /v1/auth/refresh` marks it used and returns a new access and refresh pair in the same _family_ (one family per login). Each refresh token works once. Logging out with `POST /v1/auth/logout` revokes the family and leaves the merchant's other sessions alone.
- **Reuse means theft, so the whole family is revoked.** A used token should never come back. If one does, someone has a copy, and we can't tell whether it's the attacker or the real client. Revoking every token in the family, including the newest, logs out both, so the real user has to log in again and the attacker is locked out. All failures (unknown, expired, revoked, reused) get the same `401`, so the response doesn't reveal why.
- **No grace period for concurrent refreshes.** Two requests with the same token are serialised by a per-family Postgres advisory lock. The first one rotates; the second looks like reuse and revokes the family. A buggy client that refreshes twice in parallel gets logged out, but an attacker can't slip in during a grace window. The lock also makes sure a revocation can't miss a token that is being inserted at the same moment.
- **Refresh tokens are random and stored as SHA-256 hashes.** They carry 256 bits of entropy, so a fast hash is enough (argon2 is for low-entropy passwords). A database leak doesn't give anyone usable tokens.
- **Email uniqueness is enforced by the database.** `merchants_email_lower_idx` is a unique index on `lower(email)`. Registration relies on it instead of checking first, so two concurrent sign-ups can't both succeed.
- **Rate limiting uses a sliding-window log in Redis.** Each key is a sorted set of request timestamps. One Lua script removes entries older than the window, counts the rest and adds the new request only if it fits, so the check is atomic and concurrent requests can't overshoot. Limits: login 5/min per IP + email, payments 60/min per API key, everything 300/min per IP. Responses carry `RateLimit-Limit` and `RateLimit-Remaining`, plus `Retry-After` on `429`.
  - _Fixed window_ (one counter per minute) is cheaper, but a client can send the full limit at 0:59 and again at 1:00: twice the limit in two seconds.
  - _Sliding-window counter_ (weighting the previous window's count) is O(1) memory, but it's an estimate that assumes requests were spread evenly, so it can let a burst through or block a client too early.
  - _Sliding-window log_ is exact. It stores one entry per request, but the limits here are small (at most 300 per key), so memory is bounded and cheap. Rejected requests aren't recorded, so a client that keeps retrying still gets back in once old entries age out.
- **Fail-open for payments, fail-closed for login.** If Redis is down, the payments limiter lets requests through, because an outage shouldn't stop merchants taking money, and idempotency keys still stop duplicate charges. The login limiter returns `503`, because without it passwords could be guessed at full speed. Both log a warning.
- **`TRUST_PROXY` is off by default.** Per-IP limits need the real client IP. Behind Render's proxy that comes from `X-Forwarded-For`, so `render.yaml` turns it on. Anywhere else, trusting that header would let clients choose their own IP and dodge the limits.
- **API keys are shown once and stored as a prefix plus a hash.** A key is `pb_test_<prefix>_<secret>`. The 12-hex-character prefix is stored in plaintext so the key can be found with one indexed lookup and shown in `GET /v1/api-keys`. The secret is 256 random bits and only its SHA-256 hash is stored (compared in constant time), so neither a database leak nor the logs (the `Authorization` header is redacted) give anyone a working key. Like refresh tokens, the secret is high-entropy, so a fast hash is enough.
- **Unknown, revoked and wrong-secret API keys get the same `401`.** Revoking sets `revoked_at` and takes effect on the next request; there is no cache to wait out. Every successful request updates `last_used_at`, so merchants can spot keys that are unused and safe to revoke.
- **Separate credentials for people and servers.** Access tokens (short-lived, from a password login) manage the account, including creating keys. API keys (long-lived, revocable, one per server) take payments. A leaked API key can't create more keys or change the account, and access tokens aren't accepted on payment routes or vice versa.
- **Fastify over Express.** It has schema-based validation and serialisation built in, and OpenAPI generation comes from the same schemas.
- **zod schemas are the single source of truth for each route.** The same schema validates the request, types the handler, filters the response (unknown fields are never serialised, so a column like `key_hash` can't leak by accident) and generates the OpenAPI document served at `/openapi.json` and `/docs`. Every route documents its request, its responses and an example payload, and a test fails if one doesn't or if the document stops being valid OpenAPI 3.1.

## Deployment

`render.yaml` is a Render Blueprint that creates the web service (Docker), PostgreSQL and Key Value (Redis). Connect the repo in Render → **New → Blueprint**.

## License

MIT
