// Creates database clients without opening a connection at module import time.
// Runtime SQL and Drizzle never share a client: Drizzle rewrites its client's date codecs.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

export interface DrizzleConnection {
  close: () => Promise<void>;
  db: PostgresJsDatabase<typeof schema>;
}

export function createSqlClient(databaseUrl: string): Sql {
  // One connection per serverless instance; prepare: false is required because
  // the Supabase transaction pooler (port 6543 / PgBouncer) does not support prepared statements.
  return postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

export function createDrizzleConnection(
  databaseUrl: string,
): DrizzleConnection {
  // A dedicated client keeps Drizzle's transparent date serializers away from repository SQL.
  const sql = createSqlClient(databaseUrl);
  return { db: drizzle(sql, { schema }), close: async () => sql.end() };
}
