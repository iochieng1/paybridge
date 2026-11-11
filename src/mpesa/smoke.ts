/**
 * Manual Daraja sandbox smoke test (see README). Sends a real STK push to the
 * given phone, then polls STK Push Query until the customer responds.
 *
 *   npm run mpesa:smoke -- 0712345678 [amount]
 */
import { Redis } from "ioredis";

import { loadConfig } from "../config.js";
import { createDarajaClient, DARAJA_BASE_URLS } from "./daraja.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 24; // About two minutes; STK prompts expire after ~60s.

const main = async () => {
  const [phone, amount = "1"] = process.argv.slice(2);
  if (!phone) {
    throw new Error("Usage: npm run mpesa:smoke -- <phone> [amount]");
  }

  const config = loadConfig();
  if (config.MPESA_ENV !== "sandbox") {
    throw new Error("The smoke test only runs against the sandbox");
  }

  const redis = new Redis(config.REDIS_URL);
  try {
    const daraja = createDarajaClient({
      consumerKey: config.MPESA_CONSUMER_KEY,
      consumerSecret: config.MPESA_CONSUMER_SECRET,
      shortcode: config.MPESA_SHORTCODE,
      passkey: config.MPESA_PASSKEY,
      baseUrl: DARAJA_BASE_URLS.sandbox,
      redis,
    });

    await daraja.accessToken();
    console.log("OAuth token: ok (cached in Redis)");

    const push = await daraja.stkPush({
      amount: Number(amount),
      phone,
      accountReference: "SMOKE-TEST",
      description: "Smoke test",
      callbackUrl: `${config.PUBLIC_BASE_URL}/v1/mpesa/callback/smoke-test`,
    });
    console.log("STK push accepted:", push);

    for (let poll = 1; poll <= MAX_POLLS; poll++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const result = await daraja.stkQuery(push.checkoutRequestId);
      console.log(`STK query #${poll}:`, result);
      if (result.status === "completed") return;
    }
    console.log("Still pending; giving up.");
  } finally {
    await redis.quit();
  }
};

await main();
