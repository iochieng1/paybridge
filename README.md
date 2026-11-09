# PayBridge

[![CI](https://github.com/iochieng1/paybridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iochieng1/paybridge/actions/workflows/ci.yml)

**An M-Pesa payments gateway API that is rate-limited, idempotent, and can't double-credit a payment.**

> 🚧 Work in progress. Day 1 of 10: scaffold, database schema, health checks, CI.
>
> <!-- TODO: demo GIF here once payments work (day 10) -->
>
> **Live API:** _coming soon_ · **Docs:** `/docs` (Swagger UI, day 5)

PayBridge lets any app accept M-Pesa payments through one clean REST API. It deals with the messy parts of Safaricom's Daraja API: STK push timeouts, duplicate callbacks, unsigned webhooks and token expiry. You don't have to.

The public demo runs against the **Daraja sandbox**. No real money moves.

## Features (roadmap)

- [x] Fastify + TypeScript service with validated config and graceful shutdown
- [x] PostgreSQL schema and migrations for merchants, tokens, API keys, payments, audit log, idempotency and webhooks
- [x] `/health` endpoint that checks Postgres and Redis
- [x] CI: lint, format, typecheck, migration drift check, integration tests on real Postgres/Redis, secret scanning
- [x] Merchant registration and login (argon2id passwords, 15-minute access JWT)
- [ ] Refresh-token rotation and reuse detection
- [ ] Redis sliding-window rate limiter (atomic Lua script)
- [ ] API keys and OpenAPI/Swagger docs
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
  routes/           # HTTP routes
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
- **Short-lived stateless access tokens.** Access JWTs (HS256) last 15 minutes and aren't stored, so verifying one needs no database lookup for the token itself. Revocation comes from refresh-token rotation (Day 3).
- **Email uniqueness is enforced by the database.** `merchants_email_lower_idx` is a unique index on `lower(email)`. Registration relies on it instead of checking first, so two concurrent sign-ups can't both succeed.
- **Fastify over Express.** It has schema-based validation and serialisation built in, and OpenAPI generation comes from the same schemas.

## Deployment

`render.yaml` is a Render Blueprint that creates the web service (Docker), PostgreSQL and Key Value (Redis). Connect the repo in Render → **New → Blueprint**.

## License

MIT
