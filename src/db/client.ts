import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export const createDb = (databaseUrl: string) => {
  const sql = postgres(databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema });

  return { db, sql };
};

export type Database = ReturnType<typeof createDb>["db"];
