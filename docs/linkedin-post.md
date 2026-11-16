I built PayBridge: an M-Pesa payments API that can't charge a customer twice and can't credit a payment twice. 🇰🇪💸

🎥 In the video: a merchant creates a payment, retries it with the same key (no second prompt), the customer enters their PIN, and a signed webhook confirms it.

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

Then I load-tested the live deployment with k6: 241 payment requests in one minute against a limit of 60. The rate limiter let exactly 60 through.

But 1 request in 268 came back as a 500. The Daraja sandbox had given two STK pushes to the same phone, in the same second, the same CheckoutRequestID. My unique constraint rejected the second one after the prompt had already gone out, leaving that payment stuck. Now it's treated like any push with an unclear outcome, and its callback settles it. The rerun: zero 5xx.

The lesson I keep relearning: test against the real thing. A mock would never have handed me a duplicate ID.

Stack: TypeScript · Fastify · PostgreSQL · Redis · BullMQ · Docker. Tested against real Postgres and Redis, because the guarantees come from database constraints and locks.

🔗 Code: github.com/iochieng1/paybridge
📖 Try it (sandbox, no real money): https://paybridge-api-1s9j.onrender.com/docs
(It's on a free plan, so the first request may take a minute to wake it up.)

What's the worst payment bug you've had to debug? 👇

#TypeScript #NodeJS #Fintech #MPesa #BackendEngineering #Kenya #SoftwareEngineering
