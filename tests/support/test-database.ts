// Provides each integration suite with an isolated test database and fixed fixtures.
// Tests run ONLY against TEST_DATABASE_URL (or an isolated embedded Postgres).
// Production DATABASE_URL is strictly guarded and never touched by tests.
import type { Sql } from "postgres";

import { createSqlClient } from "@/db/client";
import { startEmbeddedDatabase } from "@/db/embedded-database";
import { runMigrations } from "@/db/migrations";

export const DOCTOR_ID = "10000000-0000-4000-8000-000000000001";
export const PATIENT_ID = "20000000-0000-4000-8000-000000000001";
export const OTHER_PATIENT_ID = "20000000-0000-4000-8000-000000000002";

export interface TestDatabase {
  close(): Promise<void>;
  reset(): Promise<void>;
  sql: Sql;
}

export interface ProjectIdentity {
  projectRef: string | null;
  host: string;
  database: string;
}

export function extractProjectIdentity(urlStr: string): ProjectIdentity {
  const parsed = new URL(urlStr);
  const username = decodeURIComponent(parsed.username);
  let projectRef: string | null = null;
  if (username.startsWith("postgres.")) {
    projectRef = username.slice("postgres.".length);
  } else if (
    parsed.hostname.startsWith("db.") &&
    parsed.hostname.endsWith(".supabase.co")
  ) {
    projectRef = parsed.hostname.slice(3, -".supabase.co".length);
  }
  return {
    projectRef,
    host: parsed.hostname,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

export function isSameDatabaseProject(
  mainUrlStr: string,
  testUrlStr: string,
): boolean {
  try {
    const main = extractProjectIdentity(mainUrlStr);
    const test = extractProjectIdentity(testUrlStr);

    if (main.projectRef && test.projectRef) {
      return main.projectRef === test.projectRef;
    }
    if (main.projectRef && test.host.includes(main.projectRef)) {
      return true;
    }
    if (test.projectRef && main.host.includes(test.projectRef)) {
      return true;
    }
    return main.host === test.host && main.database === test.database;
  } catch {
    return false;
  }
}

/**
 * Ensures test database configuration never points to the main database project.
 * Compares project identifier, host, and database name.
 * Prints ONLY true/false for "same project", never credential values.
 */
export function assertTestDatabaseSafety(
  mainUrl?: string,
  testUrl?: string,
): void {
  const main = mainUrl ?? process.env.DATABASE_URL;
  const test = testUrl ?? process.env.TEST_DATABASE_URL;
  if (main && test && main.trim() !== "" && test.trim() !== "") {
    const same = isSameDatabaseProject(main, test);
    console.log(`[database-safety] same project: ${same}`);
    if (same) {
      throw new Error(
        "Safety guard violation: TEST_DATABASE_URL points to the same project as DATABASE_URL. Tests must run strictly against an isolated test database.",
      );
    }
  }
}

export async function ensureTestMarkerTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _test_database (
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
}

export async function assertTestMarkerTable(sql: Sql): Promise<void> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = '_test_database'
    ) as exists
  `;
  if (!rows[0]?.exists) {
    throw new Error(
      "Safety guard violation: Marker table '_test_database' does not exist. Aborting truncate/reset on non-test database.",
    );
  }
}

interface SharedDbState {
  close: () => Promise<void>;
  sql: Sql;
}

let sharedDbPromise: Promise<SharedDbState> | null = null;

async function getOrCreateSharedDb(): Promise<SharedDbState> {
  if (!sharedDbPromise) {
    sharedDbPromise = (async () => {
      assertTestDatabaseSafety();

      const testUrl = process.env.TEST_DATABASE_URL;
      if (testUrl) {
        const sql = createSqlClient(testUrl);
        await ensureTestMarkerTable(sql);
        await runMigrations(sql);
        // Ensure any test reading DATABASE_URL only reaches the test database
        process.env.DATABASE_URL = testUrl;
        return {
          sql,
          close: async () => {
            await sql.end();
          },
        };
      }

      // Default fallback: isolated embedded Postgres instance with wire-protocol support
      const embedded = await startEmbeddedDatabase();
      const sql = createSqlClient(embedded.url);
      await ensureTestMarkerTable(sql);
      process.env.DATABASE_URL = embedded.url;
      return {
        sql,
        close: async () => {
          await sql.end();
          await embedded.close();
        },
      };
    })();
  }
  return sharedDbPromise;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const shared = await getOrCreateSharedDb();

  const reset = async () => {
    await assertTestMarkerTable(shared.sql);
    await shared.sql`TRUNCATE appointments, patients, availability_rules, time_off, doctors,
      rate_limit_buckets, calls, tool_calls, eval_runs CASCADE`;
    await insertFixtures(shared.sql);
  };

  await reset();

  return {
    sql: shared.sql,
    reset,
    close: async () => {
      // Connection lifecycle is managed across the test runner session
    },
  };
}

export async function closeSharedTestDatabase(): Promise<void> {
  if (sharedDbPromise) {
    const shared = await sharedDbPromise;
    sharedDbPromise = null;
    await shared.close();
  }
}

async function insertFixtures(sql: Sql): Promise<void> {
  // One weekday doctor with four 30-minute morning slots keeps expected results readable.
  await sql`
    INSERT INTO doctors (id, full_name, specialty, timezone)
    VALUES (${DOCTOR_ID}, 'Dr. Test', 'Family Medicine', 'America/New_York')
  `;
  await sql`
    INSERT INTO availability_rules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
    SELECT ${DOCTOR_ID}, day, '09:00', '11:00', 30 FROM generate_series(1, 5) AS day
  `;
  await sql`
    INSERT INTO patients (id, full_name, date_of_birth, phone_e164) VALUES
      (${PATIENT_ID}, 'Alex Morgan', '1988-04-12', '+15555550101'),
      (${OTHER_PATIENT_ID}, 'Sam Rivera', '2017-09-03', '+15555550102')
  `;
}

export async function connectDoctorCalendar(sql: Sql): Promise<void> {
  await sql`
    UPDATE doctors SET calendar_provider = 'google', external_calendar_id = 'clinic@example.com'
    WHERE id = ${DOCTOR_ID}
  `;
}
