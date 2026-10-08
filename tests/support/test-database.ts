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

/**
 * Ensures test database configuration never points to the main database.
 * Throws immediately if TEST_DATABASE_URL matches DATABASE_URL.
 */
export function assertTestDatabaseSafety(
  mainUrl?: string,
  testUrl?: string,
): void {
  const main = mainUrl ?? process.env.DATABASE_URL;
  const test = testUrl ?? process.env.TEST_DATABASE_URL;
  if (main && test && main.trim() !== "" && main.trim() === test.trim()) {
    throw new Error(
      `Safety guard violation: TEST_DATABASE_URL cannot equal DATABASE_URL (${main}). Tests must run strictly against an isolated test database.`,
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
