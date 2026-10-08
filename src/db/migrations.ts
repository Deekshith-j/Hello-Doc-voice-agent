// Applies every pending SQL migration exactly once in lexical order.
// Each file gets its own transaction so failures never leave a partial migration.
import { readdir, readFile } from "node:fs/promises";

import type { Sql } from "postgres";

const migrationsUrl = new URL("../../drizzle/", import.meta.url);

export async function runMigrations(sql: Sql): Promise<string[]> {
  // This small ledger makes deployment retries safe without weakening the migration SQL.
  await sql`CREATE TABLE IF NOT EXISTS app_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const fileNames = (await readdir(migrationsUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const fileName of fileNames) {
    if (await applyMigration(sql, fileName)) applied.push(fileName);
  }
  return applied;
}

async function applyMigration(sql: Sql, fileName: string): Promise<boolean> {
  const migrationName = fileName.replace(/\.sql$/, "");
  const existing = await sql<{ name: string }[]>`
    SELECT name FROM app_migrations WHERE name = ${migrationName}
  `;
  if (existing.length > 0) return false;

  const migrationSql = await readFile(new URL(fileName, migrationsUrl), "utf8");
  await sql.begin(async (transaction) => {
    await transaction.unsafe(migrationSql);
    await transaction`INSERT INTO app_migrations (name) VALUES (${migrationName})`;
  });
  return true;
}
