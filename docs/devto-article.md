---
title: "Building an M-Pesa gateway that can't double-charge: idempotency, state machines and signed webhooks"
published: false
tags: typescript, node, postgres, fintech
---

<!-- Draft for dev.to. Add the live URL and the demo GIF before publishing. -->

Accepting M-Pesa in an app looks easy. You call Safaricom's Daraja API, the customer gets a PIN prompt (an "STK push"), and Daraja calls you back with the result.

The trouble starts after that call. Callbacks arrive twice, arrive late or never arrive. They aren't signed. Your HTTP client times out, retries, and the customer gets two prompts. Each of these can mean taking someone's money twice, or marking an order unpaid when it was paid.

I built [PayBridge](https://github.com/iochieng1/paybridge), a small payments gateway that sits between apps and Daraja, to handle these cases properly. Here are the four ideas that do most of the work.

## 1. Let Postgres decide who goes first

A merchant's server sends `POST /v1/payments` with an `Idempotency-Key` header. If the request times out, it retries with the same key. The retry must not send a second STK push.

The usual check-then-insert is a race:

```ts
// ❌ Two concurrent retries can both see "no key" and both charge.
const existing = await findKey(merchantId, key);
if (!existing) {
  await insertKey(merchantId, key);
  await sendStkPush();
}
```

Instead, the claim is a single statement:

```sql
INSERT INTO idempotency_keys (merchant_id, key, request_hash)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING
RETURNING key;
```

The primary key is `(merchant_id, key)`. However many requests arrive at once, Postgres lets exactly one insert through. That request sends the push. The others get `409 Retry-After: 1` while it runs, and a replay of its stored response once it's done. The row also stores a hash of the request body, so reusing a key for a _different_ payment gets `422` instead of silently returning the wrong payment.

One subtle rule: if anything fails **after** Daraja was called, the key is never released. A retry that gets `409` until the key expires is annoying. Releasing the key could charge the customer twice.

## 2. A state machine that only moves forward

A payment goes `CREATED → PENDING → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT`. Every change is one conditional update:

```sql
UPDATE payments
SET status = $new_status, ...
WHERE id = $id AND status IN ('CREATED', 'PENDING')
RETURNING *;
```

If no row comes back, the payment was already final, so nothing happens. A duplicate callback, a replay, or a late "failed" arriving after a success all update no row and record no event. Daraja still gets `200` so it stops resending. The audit event is inserted in the same transaction, so the history can't disagree with the status.

The test I like most sends 10 copies of the same callback **concurrently** and asserts that exactly one `callback_applied` event exists. It runs against real Postgres via Testcontainers, because a mock can't test a row lock.

## 3. Callbacks aren't signed, so use three checks

Anyone who finds a callback URL can post `"ResultCode": 0`. PayBridge layers three checks:

1. **A secret URL per payment.** Each callback URL carries 256 random bits, and only its SHA-256 hash is stored.
2. **An optional IP allowlist** for Safaricom's ranges, so a leaked URL is useless from elsewhere.
3. **Verification for anything odd.** If the amount doesn't match, the receipt is missing or the checkout ID is wrong, PayBridge asks Daraja directly with STK Push Query and applies _that_ answer, never the callback's claim.

## 4. Assume the callback never comes

Sometimes Daraja just doesn't call back. A job runs every minute (a BullMQ repeatable job), finds payments stuck in `PENDING` for over 2 minutes, and asks Daraja for their status. It applies the result with the **same** conditional update, so a reconciliation that races a late callback still settles the payment exactly once.

## Telling the merchant: signed webhooks

When a payment is final, PayBridge POSTs it to the merchant:

```
X-PayBridge-Signature: t=1794000000,v1=<hex HMAC-SHA256(secret, "t.body")>
```

- The **timestamp is part of what's signed**, so a captured request can't be replayed later with a new timestamp. Receivers reject anything older than 5 minutes.
- Retries happen after 1m, 5m, 30m, 2h and 12h, and every attempt is logged and visible through the API.
- Delivery is **at least once**: if the merchant's `200` gets lost, PayBridge can't know. Each payment has one stable event ID, so merchants can safely drop duplicates.
- The merchant's URL is checked against private address ranges **inside the socket's DNS lookup**, so a URL can't point PayBridge at `169.254.169.254` or an internal service, even through DNS rebinding.

## What I'd tell myself at the start

- **Make the database enforce your invariants.** Unique constraints, conditional updates and advisory locks are much harder to get wrong than application-level checks.
- **Test against real infrastructure.** Every important guarantee here comes from Postgres or a Redis Lua script.
- **"Unknown" is a real state.** A timeout doesn't mean failure. Leaving the payment `PENDING` and letting the callback or reconciliation decide is what keeps money correct.

The code, a full trade-offs section and the OpenAPI docs are on [GitHub](https://github.com/iochieng1/paybridge). It runs against the Daraja sandbox, so you can try it without moving real money.
