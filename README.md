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
- [x] Typed Daraja client: OAuth token cached in Redis, STK push, STK Push Query
- [x] STK push payments with `Idempotency-Key` support
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
| `npm run mpesa:smoke -- <phone>`     | Manual Daraja sandbox smoke test (see below)                   |
| `npm run build && npm start`         | Production build; `start` applies migrations, then boots       |

## Payments

A merchant server creates a payment with its API key. The `Idempotency-Key` header is required:

```bash
curl -X POST http://localhost:3000/v1/payments \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: order-1001-attempt-1" \
  -H "Content-Type: application/json" \
  -d '{"phone": "0712345678", "amount": 1500, "reference": "INV-1001", "description": "Order 1001"}'
```

- `202` with `status: "PENDING"`: the customer has the STK prompt; the result arrives by callback.
- `502` with `status: "FAILED"` and `result_desc`: M-Pesa rejected the push.
- Retrying with the same key and body returns the first response with `Idempotent-Replayed: true`, and never sends a second push. The same key with a different body gets `422`; a retry while the first request is still running gets `409` with `Retry-After: 1`. Keys are kept for 24 hours.
- `GET /v1/payments/:id` returns one payment; `GET /v1/payments?status=SUCCEEDED&created_from=…&created_to=…&limit=20&cursor=…` lists them newest first. A merchant only ever sees its own payments.
- Amounts are whole shillings from 1 to 250,000. Every status change is appended to `payment_events`.

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
  mpesa/            # Daraja client (OAuth, STK push, STK query), phone normalisation
  payments/         # Payment creation, state transitions, idempotency keys
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
- **The Daraja OAuth token lives in Redis, not in process memory.** Every instance shares one token, so a deploy or restart doesn't fetch a new one, and Daraja's token endpoint isn't hit once per process. It is refreshed a minute early so a request never goes out with a token that expires in flight. The cache key holds a hash of the consumer key, never the key itself.
- **Daraja calls aren't retried, apart from one retry after a rejected token.** Retrying an STK push after a timeout could prompt the customer twice. Whether a push went through is answered later by the callback or STK Push Query, not by guessing.
- **Idempotency keys are claimed with `INSERT … ON CONFLICT DO NOTHING`.** The primary key is `(merchant_id, key)`, so of any number of concurrent requests with the same key, Postgres lets exactly one insert through. Only that one sends the STK push; the rest get `409` while it runs and a replay of its stored response afterwards. Checking first and inserting after would let two requests both see "no key" and both charge the customer. The key also stores a SHA-256 of the request (phone normalised, field order ignored), so reusing a key for a different payment is caught (`422`) instead of silently returning the wrong payment.
- **`409` while in progress, rather than waiting.** Holding the duplicate request open until the first finishes would tie up a connection for as long as Daraja takes. A `409` with `Retry-After` is cheap, and the retry gets the stored response.
- **A key stays claimed if the push may have been sent.** If anything fails after Daraja was called, the key is not released: a retry with the same key gets `409` until the key expires. That's annoying but recoverable (use a new key after checking the payment); releasing it could charge the customer twice. Failures before the call release the key so the client can simply retry.
- **An unclear STK push result is left `PENDING`, not marked failed.** A timeout, network error or 5xx without an error code doesn't say whether the customer was prompted. Marking it `FAILED` would be wrong if they then pay, so the payment stays `PENDING` and the callback (found by its token, which doesn't need a checkout id) or reconciliation settles it. Only a definite rejection (a Daraja error code or a 4xx) is `FAILED`.
- **Expired keys are purged hourly and ignored on lookup.** A key older than 24 hours is deleted before it's claimed again, so expiry is exact even between purges; the hourly job only keeps the table small.
- **Cursor pagination over `(created_at, id)`.** Offsets get slow and skip or repeat rows when new payments arrive between pages; a keyset cursor doesn't. The cursor holds `created_at` as Postgres prints it, to the microsecond, because a JS `Date` keeps only milliseconds and would lose rows created within the same millisecond.
- **Fastify over Express.** It has schema-based validation and serialisation built in, and OpenAPI generation comes from the same schemas.
- **zod schemas are the single source of truth for each route.** The same schema validates the request, types the handler, filters the response (unknown fields are never serialised, so a column like `key_hash` can't leak by accident) and generates the OpenAPI document served at `/openapi.json` and `/docs`. Every route documents its request, its responses and an example payload, and a test fails if one doesn't or if the document stops being valid OpenAPI 3.1.

## M-Pesa (Daraja)

`src/mpesa/daraja.ts` is a typed client for Safaricom's Daraja API. It is configured only through environment variables (see `.env.example`):

| Variable                                       | Notes                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` | From your app on the [Daraja portal](https://developer.safaricom.co.ke) |
| `MPESA_SHORTCODE`                              | Paybill/till number; the shared sandbox one is `174379` (default)       |
| `MPESA_PASSKEY`                                | Lipa na M-Pesa Online passkey for the shortcode                         |
| `MPESA_ENV`                                    | `sandbox` (default) or `production`                                     |
| `PUBLIC_BASE_URL`                              | Public HTTPS origin Daraja sends STK callbacks to                       |

- **OAuth:** the access token is cached in Redis, shared by every instance, and refreshed 60 seconds before Daraja's roughly one-hour expiry. Concurrent callers in one process share a single fetch. If Daraja rejects a cached token anyway, the client fetches a new one and retries once. If Redis is down, it fetches a token per request instead of failing.
- **STK push:** `password = base64(shortcode + passkey + timestamp)`, with the timestamp as `YYYYMMDDHHmmss` in Africa/Nairobi time. Phone numbers in any common format (`0712 345 678`, `+254712345678`, `0110…`) are normalised to `2547XXXXXXXX` / `2541XXXXXXXX`; anything else is rejected before calling Daraja.
- **STK Push Query** returns `{ status: "completed", resultCode, ... }` or `{ status: "pending" }` while the customer hasn't responded. Reconciliation will use it for lost callbacks.
- Every call has a 10-second timeout, and failures throw a `DarajaError` carrying the HTTP status and Daraja's `errorCode`.

Tests run the client against a fake Daraja HTTP server on localhost, so CI never touches the network.

### Sandbox smoke test (manual)

Run this after changing the client to check it against the real sandbox. It needs a Safaricom number with the M-Pesa app or SIM toolkit; the sandbox doesn't move real money.

1. Create an app on the [Daraja portal](https://developer.safaricom.co.ke) with **M-Pesa Sandbox** enabled. Put its Consumer Key and Secret in `.env` as `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET`, and the sandbox passkey (APIs → M-Pesa Express → Simulate) as `MPESA_PASSKEY`. Keep `MPESA_SHORTCODE=174379` and `MPESA_ENV=sandbox`.
2. Set `PUBLIC_BASE_URL` to any HTTPS URL. The smoke test reads the result with STK Push Query, so the callback doesn't have to be reachable; use a tunnel (`ngrok http 3000`) if you want to see it arrive.
3. Start Redis (`docker compose up -d`) and run:

   ```bash
   npm run mpesa:smoke -- 0712345678      # optional second argument: amount (default 1)
   ```

4. Expect `OAuth token: ok`, then `STK push accepted` with a `checkoutRequestId`, and a payment prompt on the phone. Enter the PIN or cancel; within a few polls the script prints `status: "completed"` with `resultCode: 0` (paid) or `1032` (cancelled). Running it again within the hour reuses the cached token.

## Deployment

`render.yaml` is a Render Blueprint that creates the web service (Docker), PostgreSQL and Key Value (Redis). Connect the repo in Render → **New → Blueprint**.

## License

MIT
