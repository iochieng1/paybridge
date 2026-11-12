import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // HS256 signing key for access tokens. 32+ characters so it can't be brute-forced.
  JWT_SECRET: z.string().min(32),
  // Trust X-Forwarded-For for the client IP. Only enable behind a proxy that
  // sets it (e.g. Render); otherwise clients could spoof their IP and dodge
  // per-IP rate limits.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Safaricom Daraja (M-Pesa). Credentials come only from the environment.
  MPESA_CONSUMER_KEY: z.string().min(1),
  MPESA_CONSUMER_SECRET: z.string().min(1),
  // 174379 is Safaricom's shared sandbox paybill.
  MPESA_SHORTCODE: z
    .string()
    .regex(/^\d{5,7}$/, "Must be a 5-7 digit shortcode")
    .default("174379"),
  MPESA_PASSKEY: z.string().min(1),
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  // Public HTTPS origin Daraja sends STK callbacks to (no trailing slash).
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((url) => url.replace(/\/+$/, "")),
  // Comma-separated IPs allowed to post STK callbacks; empty means any.
  // Daraja doesn't sign callbacks, so this is one of three checks: see the
  // README. Behind a proxy it needs TRUST_PROXY to see the real client IP.
  MPESA_CALLBACK_IP_ALLOWLIST: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((ip) => ip.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.union([z.ipv4(), z.ipv6()]))),
});

export type Config = z.infer<typeof envSchema>;

/** Parses and validates environment variables, failing fast on bad config. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
};
