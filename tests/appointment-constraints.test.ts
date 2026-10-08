// Exercises the real PostgreSQL range and uniqueness constraints.
// Parallel insert promises reproduce the application race under concurrent transactions.
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertTestDatabaseSafety,
  assertTestMarkerTable,
  ensureTestMarkerTable,
} from "./support/test-database";

const DOCTOR_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_PATIENT_ID = "20000000-0000-4000-8000-000000000002";
const SLOT = "[2027-01-12 14:00:00+00,2027-01-12 14:30:00+00)";

interface DbWrapper {
  close(): Promise<void>;
  count(): Promise<number>;
  insert(patientId: string, timeSpan: string, idempotencyKey: string): Promise<string>;
  insertIdempotent(patientId: string, timeSpan: string, idempotencyKey: string): Promise<string>;
  reset(): Promise<void>;
}

let db: DbWrapper;

beforeEach(async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    assertTestDatabaseSafety();
    const host = new URL(testUrl).host;
    console.log(`[TEST_DATABASE_URL host]: ${host}`);
    const sql = postgres(testUrl, { max: 4, prepare: false });
    await ensureTestMarkerTable(sql);
    db = {
      close: async () => {
        await sql.end();
      },
      reset: async () => {
        await assertTestMarkerTable(sql);
        await sql`TRUNCATE appointments, patients, availability_rules, time_off, doctors CASCADE`;
        await sql`
          INSERT INTO doctors (id, full_name, specialty, timezone)
          VALUES (${DOCTOR_ID}, 'Dr. Test', 'Family Medicine', 'America/New_York')
        `;
        await sql`
          INSERT INTO patients (id, full_name, date_of_birth, phone_e164) VALUES
            (${PATIENT_ID}, 'Patient One', '1990-01-01', '+15555550111'),
            (${OTHER_PATIENT_ID}, 'Patient Two', '1991-01-01', '+15555550112')
        `;
      },
      insert: async (patientId, timeSpan, idempotencyKey) => {
        const rows = await sql<{ id: string }[]>`
          INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key)
          VALUES (${DOCTOR_ID}, ${patientId}, ${timeSpan}::tstzrange, 'Annual checkup', ${idempotencyKey})
          RETURNING id
        `;
        if (!rows[0]?.id) throw new Error("Expected insert to return an id.");
        return rows[0].id;
      },
      insertIdempotent: async (patientId, timeSpan, idempotencyKey) => {
        const rows = await sql<{ id: string }[]>`
          INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key)
          VALUES (${DOCTOR_ID}, ${patientId}, ${timeSpan}::tstzrange, 'Annual checkup', ${idempotencyKey})
          ON CONFLICT (idempotency_key) DO UPDATE
            SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id
        `;
        if (!rows[0]?.id) throw new Error("Expected insert to return an id.");
        return rows[0].id;
      },
      count: async () => {
        const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM appointments`;
        return rows[0]?.count ?? 0;
      },
    };
    await db.reset();
  } else {
    // Isolated embedded PGlite fallback
    const pglite = await PGlite.create({ extensions: { btree_gist } });
    const migration = await readFile(
      new URL("../drizzle/0000_initial.sql", import.meta.url),
      "utf8",
    );
    await pglite.exec(migration);
    db = {
      close: async () => {
        await pglite.close();
      },
      reset: async () => {
        await pglite.query(
          `INSERT INTO doctors (id, full_name, specialty, timezone)
           VALUES ($1, 'Dr. Test', 'Family Medicine', 'America/New_York')`,
          [DOCTOR_ID],
        );
        await pglite.query(
          `INSERT INTO patients (id, full_name, date_of_birth, phone_e164) VALUES
           ($1, 'Patient One', '1990-01-01', '+15555550111'),
           ($2, 'Patient Two', '1991-01-01', '+15555550112')`,
          [PATIENT_ID, OTHER_PATIENT_ID],
        );
      },
      insert: async (patientId, timeSpan, idempotencyKey) => {
        const res = await pglite.query<{ id: string }>(
          `INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key)
           VALUES ($1, $2, $3::tstzrange, 'Annual checkup', $4)
           RETURNING id`,
          [DOCTOR_ID, patientId, timeSpan, idempotencyKey],
        );
        if (!res.rows[0]?.id) throw new Error("Expected insert to return an id.");
        return res.rows[0].id;
      },
      insertIdempotent: async (patientId, timeSpan, idempotencyKey) => {
        const res = await pglite.query<{ id: string }>(
          `INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key)
           VALUES ($1, $2, $3::tstzrange, 'Annual checkup', $4)
           ON CONFLICT (idempotency_key) DO UPDATE
             SET idempotency_key = EXCLUDED.idempotency_key
           RETURNING id`,
          [DOCTOR_ID, patientId, timeSpan, idempotencyKey],
        );
        if (!res.rows[0]?.id) throw new Error("Expected insert to return an id.");
        return res.rows[0].id;
      },
      count: async () => {
        const res = await pglite.query<{ count: number }>("SELECT count(*)::int AS count FROM appointments");
        return res.rows[0]?.count ?? 0;
      },
    };
    await db.reset();
  }
});

afterEach(async () => {
  await db?.close();
});

describe("appointment database invariants", () => {
  it("allows only one winner when overlapping appointments race", async () => {
    const attempts = await Promise.allSettled([
      db.insert(PATIENT_ID, SLOT, "race-first"),
      db.insert(OTHER_PATIENT_ID, SLOT, "race-second"),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(getPostgresCode(rejected)).toBe("23P01");
    expect(await db.count()).toBe(1);
  });

  it("returns the original row when an idempotency key is retried", async () => {
    const firstId = await db.insertIdempotent(PATIENT_ID, SLOT, "stable-request");
    const retriedId = await db.insertIdempotent(PATIENT_ID, SLOT, "stable-request");

    expect(retriedId).toBe(firstId);
    expect(await db.count()).toBe(1);
  });
});

function getPostgresCode(
  result: PromiseSettledResult<string> | undefined,
): string | undefined {
  if (
    !result ||
    result.status !== "rejected" ||
    typeof result.reason !== "object"
  )
    return undefined;
  return "code" in result.reason ? String(result.reason.code) : undefined;
}
