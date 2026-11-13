/**
 * End-to-end demo against a running PayBridge, acting as a merchant:
 * registers, logs in, creates an API key, starts a local webhook receiver,
 * creates a payment and waits for its signed webhook.
 *
 *   npm run demo -- 0712345678 [amount]
 *
 * Needs the API running (`npm run dev`) with WEBHOOK_ALLOW_PRIVATE_URLS=true,
 * since the receiver is on localhost. Options come from the environment:
 *   BASE_URL      PayBridge origin (default http://localhost:3000)
 *   RECEIVER_PORT port for the webhook receiver (default 4000)
 *
 * With Daraja sandbox credentials the phone gets a real STK prompt (no real
 * money moves). If Daraja can't reach your callback URL, reconciliation
 * settles the payment within about 3 minutes instead. Without credentials,
 * the push is rejected and you'll see a `payment.failed` webhook.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { verifySignature } from "../src/webhooks/signature.js";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const RECEIVER_PORT = Number(process.env.RECEIVER_PORT ?? 4000);
const WAIT_MINUTES = 5;

const [phone, amountArg] = process.argv.slice(2);
if (!phone) {
  console.error("Usage: npm run demo -- <phone> [amount]");
  process.exit(1);
}
const amount = Number(amountArg ?? 1);

const step = (message: string) => console.log(`\n▶ ${message}`);

const api = async <T>(
  method: string,
  path: string,
  {
    token,
    body,
    headers = {},
  }: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
};

const expectStatus = (
  label: string,
  res: { status: number; body: unknown },
  ...ok: number[]
) => {
  if (!ok.includes(res.status)) {
    console.error(`✗ ${label} failed with HTTP ${res.status}:`, res.body);
    process.exit(1);
  }
};

type Payment = {
  id: string;
  status: string;
  mpesa_receipt: string | null;
  result_desc: string | null;
};

// Webhook receiver: verifies each signature like a merchant would.
let secret = "";
let resolveWebhook: (event: { type: string; data: Payment }) => void;
const webhook = new Promise<{ type: string; data: Payment }>(
  (resolve) => (resolveWebhook = resolve),
);
const receiver = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const signature = req.headers["x-paybridge-signature"] as string | undefined;
  const check = verifySignature(secret, signature, raw);
  console.log(
    `\n📨 Webhook received: signature ${check.valid ? "✓ valid" : `✗ ${check.reason}`}`,
  );
  console.log(JSON.stringify(JSON.parse(raw), null, 2));
  res.writeHead(check.valid ? 200 : 400).end();
  if (check.valid) resolveWebhook(JSON.parse(raw));
});
await new Promise<void>((resolve) =>
  receiver.listen(RECEIVER_PORT, "127.0.0.1", resolve),
);

step(`Checking ${BASE_URL}/health`);
const health = await api<{ status: string }>("GET", "/health").catch(() => {
  console.error(`✗ Can't reach ${BASE_URL}. Is \`npm run dev\` running?`);
  process.exit(1);
});
console.log(health.body);

step("Registering a merchant and logging in");
const email = `demo-${randomUUID().slice(0, 8)}@example.com`;
const password = "demo-password-123";
expectStatus(
  "Register",
  await api("POST", "/v1/auth/register", {
    body: { email, password, name: "Demo Duka" },
  }),
  201,
);
const login = await api<{ access_token: string }>("POST", "/v1/auth/login", {
  body: { email, password },
});
expectStatus("Login", login, 200);
const accessToken = login.body.access_token;
console.log(`Logged in as ${email}`);

step("Creating an API key (shown once)");
const key = await api<{ key: string; prefix: string }>("POST", "/v1/api-keys", {
  token: accessToken,
});
expectStatus("Create API key", key, 201);
console.log(`API key prefix: ${key.body.prefix}`);

step(
  `Setting the webhook endpoint to http://localhost:${RECEIVER_PORT}/webhooks`,
);
const endpoint = await api<{ secret: string }>("PUT", "/v1/webhook-endpoint", {
  token: accessToken,
  body: { url: `http://localhost:${RECEIVER_PORT}/webhooks` },
});
if (endpoint.status === 422) {
  console.error(
    "✗ The API refused a localhost webhook URL. Set WEBHOOK_ALLOW_PRIVATE_URLS=true in .env and restart it.",
  );
  process.exit(1);
}
expectStatus("Set webhook endpoint", endpoint, 200);
secret = endpoint.body.secret;
console.log("Signing secret received");

step(`Creating a payment of KES ${amount} to ${phone}`);
const idempotencyKey = `demo-${randomUUID()}`;
const payment = await api<Payment>("POST", "/v1/payments", {
  token: key.body.key,
  headers: { "idempotency-key": idempotencyKey },
  body: { phone, amount, reference: "DEMO", description: "Demo payment" },
});
expectStatus("Create payment", payment, 202, 502);
console.log(payment.body);

step("Retrying with the same Idempotency-Key (must not prompt twice)");
const retry = await api<Payment>("POST", "/v1/payments", {
  token: key.body.key,
  headers: { "idempotency-key": idempotencyKey },
  body: { phone, amount, reference: "DEMO", description: "Demo payment" },
});
console.log(
  `HTTP ${retry.status}, same payment: ${retry.body.id === payment.body.id}`,
);

if (payment.status === 202) {
  console.log(
    "\n📱 Check the phone and enter your M-Pesa PIN (or cancel to see payment.cancelled).",
  );
}
step(`Waiting up to ${WAIT_MINUTES} minutes for the webhook`);
const timeout = setTimeout(() => {
  console.error(
    "\n✗ No webhook yet. Check the API logs; GET /v1/payments/:id shows the status.",
  );
  process.exit(1);
}, WAIT_MINUTES * 60_000);
const event = await webhook;
clearTimeout(timeout);

const attempts = await api<{ data: unknown[] }>(
  "GET",
  `/v1/payments/${payment.body.id}/webhook-deliveries`,
  { token: key.body.key },
);
step("Delivery log");
console.log(attempts.body.data);

console.log(
  `\n✅ ${event.type}: payment ${event.data.id} is ${event.data.status}${
    event.data.mpesa_receipt ? ` (receipt ${event.data.mpesa_receipt})` : ""
  }`,
);
receiver.close();
process.exit(0);
