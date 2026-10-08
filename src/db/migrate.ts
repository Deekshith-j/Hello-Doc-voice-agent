// Runs pending migrations against DATABASE_URL from the command line or a deploy step.
// The migration logic itself lives in migrations.ts so local tooling can reuse it.
import { createSqlClient } from "./client";
import { runMigrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required to run migrations.");

const sql = createSqlClient(databaseUrl);
try {
  const applied = await runMigrations(sql);
  console.log(
    applied.length
      ? `Applied ${applied.join(", ")}.`
      : "Database is already up to date.",
  );
} finally {
  await sql.end();
}
