// Exercises the real PostgreSQL range and uniqueness constraints in an embedded database.
// Parallel insert promises reproduce the application race without requiring shared test infrastructure.
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DOCTOR_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_PATIENT_ID = "20000000-0000-4000-8000-000000000002";
const SLOT = "[2027-01-12 14:00:00+00,2027-01-12 14:30:00+00)";

let database: PGlite;

beforeEach(async () => {
  database = await PGlite.create({ extensions: { btree_gist } });
  const migration = await readFile(
    new URL("../drizzle/0000_initial.sql", import.meta.url),
    "utf8",
  );
  await database.exec(migration);
  await insertFixtures(database);
});

afterEach(async () => {
  await database.close();
});

describe("appointment database invariants", () => {
  it("allows only one winner when overlapping appointments race", async () => {
    const attempts = await Promise.allSettled([
      insertAppointment(database, PATIENT_ID, SLOT, "race-first"),
      insertAppointment(database, OTHER_PATIENT_ID, SLOT, "race-second"),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(getPostgresCode(rejected)).toBe("23P01");
    expect(await appointmentCount(database)).toBe(1);
  });

  it("returns the original row when an idempotency key is retried", async () => {
    const firstId = await insertIdempotently(
      database,
      PATIENT_ID,
      SLOT,
      "stable-request",
    );
    const retriedId = await insertIdempotently(
      database,
      PATIENT_ID,
      SLOT,
      "stable-request",
    );

    expect(retriedId).toBe(firstId);
    expect(await appointmentCount(database)).toBe(1);
  });
});

async function insertFixtures(db: PGlite): Promise<void> {
  // Fixed IDs make the constraint setup deterministic and keep failures easy to reproduce.
  await db.query(
    `INSERT INTO doctors (id, full_name, specialty, timezone)
     VALUES ($1, 'Dr. Test', 'Family Medicine', 'America/New_York')`,
    [DOCTOR_ID],
  );
  await db.query(
    `INSERT INTO patients (id, full_name, date_of_birth, phone_e164) VALUES
     ($1, 'Patient One', '1990-01-01', '+15555550111'),
     ($2, 'Patient Two', '1991-01-01', '+15555550112')`,
    [PATIENT_ID, OTHER_PATIENT_ID],
  );
}

async function insertAppointment(
  db: PGlite,
  patientId: string,
  timeSpan: string,
  idempotencyKey: string,
): Promise<string> {
  // Different idempotency keys isolate the range exclusion constraint exercised by the race.
  const result = await db.query<{ id: string }>(
    `INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key)
     VALUES ($1, $2, $3::tstzrange, 'Annual checkup', $4)
     RETURNING id`,
    [DOCTOR_ID, patientId, timeSpan, idempotencyKey],
  );
  return requireFirstId(result.rows);
}

async function insertIdempotently(
  db: PGlite,
  patientId: string,
  timeSpan: string,
  idempotencyKey: string,
): Promise<string> {
  // A no-op conflict update returns the original ID in one round trip without a read-then-write race.
  const result = await db.query<{ id: string }>(
    `INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key)
     VALUES ($1, $2, $3::tstzrange, 'Annual checkup', $4)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [DOCTOR_ID, patientId, timeSpan, idempotencyKey],
  );
  return requireFirstId(result.rows);
}

async function appointmentCount(db: PGlite): Promise<number> {
  // Counting rows verifies that a rejected request did not leave partial state behind.
  const result = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM appointments",
  );
  return result.rows[0]?.count ?? 0;
}

function requireFirstId(rows: readonly { id: string }[]): string {
  const id = rows[0]?.id;
  if (!id) throw new Error("Expected the insert to return an appointment id.");
  return id;
}

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
