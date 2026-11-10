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
