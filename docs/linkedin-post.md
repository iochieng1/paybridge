I built PayBridge: an M-Pesa payments API that can't charge a customer twice and can't credit a payment twice. 🇰🇪💸

If you've built on Safaricom's Daraja API, you know the hard part isn't sending the STK push. It's everything after it:

→ The callback arrives twice. Or arrives late. Or never arrives.
→ Callbacks aren't signed, so anyone who finds the URL can post a fake "paid".
→ A client times out and retries, and the customer gets two PIN prompts.

PayBridge handles all of that behind one REST endpoint:

✅ Idempotency keys. A retried request replays the first response and never sends a second push. Postgres decides who goes first with INSERT … ON CONFLICT, so concurrent retries can't both get through.
✅ A forward-only state machine. A payment only moves out of PENDING once. Duplicate, replayed and late callbacks change nothing, even when 10 copies arrive at the same time.
✅ Callbacks that can't be forged. Each payment gets its own secret callback URL, with an optional IP allowlist. Anything suspicious is checked against Daraja directly before it counts.
✅ Reconciliation. Every minute, payments stuck in PENDING are looked up with STK Push Query and settled.
✅ Signed webhooks to merchants (HMAC-SHA256 with a replay window), retried for about 15 hours with backoff, with SSRF protection.
✅ Plus refresh-token rotation with reuse detection, API keys, a Redis sliding-window rate limiter and OpenAPI docs.

Stack: TypeScript · Fastify · PostgreSQL · Redis · BullMQ · Docker. It's tested against real Postgres and Redis, because the guarantees come from database constraints and locks, and mocks would test none of them.

🔗 Code: github.com/iochieng1/paybridge
📖 Try it (sandbox, no real money): [live /docs URL]

What's the worst payment bug you've had to debug? 👇

#TypeScript #NodeJS #Fintech #MPesa #BackendEngineering #Kenya #SoftwareEngineering
