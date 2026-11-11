/** True for a Postgres unique-constraint violation (SQLSTATE 23505). */
export const isUniqueViolation = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  // postgres.js reports SQLSTATE in `code`; Drizzle wraps it in `cause`.
  const { code, cause } = err as { code?: unknown; cause?: unknown };
  return code === "23505" || isUniqueViolation(cause);
};
