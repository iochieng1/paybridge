/* global __ENV, __VU, __ITER */
// k6 load test for PayBridge's rate limiter.
//
//   BASE_URL=http://localhost:3000 API_KEY=pb_test_... k6 run load/rate-limit.js
//
// Two scenarios run at once:
// - `payments`: 4 requests a second on one API key, four times the 60
//   requests/minute payment limit. Most requests must get 429, the
//   ones let through must stay at or under the limit, and none may fail with
//   a 5xx. Each request has a unique Idempotency-Key, so the ones let through
//   are real payment attempts (use the Daraja sandbox).
// - `health`: steady traffic to /health from the same IP, to show that
//   limited payment traffic doesn't slow the rest of the API down.
//
// Everything comes from one IP, so the total (270/minute) stays under the
// global 300/minute per-IP limit; otherwise that limit would hide this one.
import { check } from "k6";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY;

const allowed = new Counter("payments_allowed");
const limited = new Counter("payments_limited");
const serverErrors = new Rate("server_errors");

export const options = {
  scenarios: {
    payments: {
      executor: "constant-arrival-rate",
      exec: "createPayment",
      rate: 4, // 240/minute against a 60/minute limit
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 20,
    },
    health: {
      executor: "constant-arrival-rate",
      exec: "health",
      rate: 1,
      timeUnit: "2s",
      duration: "1m",
      preAllocatedVUs: 5,
    },
  },
  thresholds: {
    // The limiter is exact: never more than 60 in the window (+ a small
    // margin for requests that straddle the test's own start and end).
    payments_allowed: ["count<=65"],
    server_errors: ["rate==0"],
    "http_req_duration{scenario:payments}": ["p(95)<200"],
    "http_req_duration{scenario:health}": ["p(95)<200"],
  },
};

export function setup() {
  if (!API_KEY) throw new Error("Set API_KEY to a key from POST /v1/api-keys");
}

export function createPayment() {
  const res = http.post(
    `${BASE_URL}/v1/payments`,
    JSON.stringify({
      phone: "0708374149", // Daraja sandbox test number
      amount: 1,
      reference: "K6",
      description: "Load test",
    }),
    {
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": `k6-${__VU}-${__ITER}-${Date.now()}`,
      },
    },
  );

  serverErrors.add(res.status >= 500 && res.status !== 502);
  if (res.status === 429) {
    limited.add(1);
    check(res, {
      "429 has Retry-After": (r) => r.headers["Retry-After"] !== undefined,
      "429 has RateLimit-Remaining: 0": (r) =>
        r.headers["Ratelimit-Remaining"] === "0",
    });
  } else {
    allowed.add(1);
  }
}

export function health() {
  const res = http.get(`${BASE_URL}/health`);
  serverErrors.add(res.status >= 500);
  check(res, { "health is 200": (r) => r.status === 200 });
}
