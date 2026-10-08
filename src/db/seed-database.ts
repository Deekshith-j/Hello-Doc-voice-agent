// Seeds synthetic doctors, schedules, leave, patients, and a week of booked appointments.
// Reruns are safe: rows are upserted and seeded bookings use deterministic idempotency keys.
import { TZDate } from "@date-fns/tz";
import { inArray } from "drizzle-orm";

import { getFreeSlots } from "@/domain/get-free-slots";

import { createDrizzleConnection, createSqlClient } from "./client";
import { PostgresClinicRepository } from "./postgres-clinic-repository";
import { availabilityRules, doctors, patients, timeOff } from "./schema";
import { seedDoctors, seedPatients, seedRules } from "./seed-data";

const SEEDED_DAYS = 5;
const SEED_REASONS = [
  "Annual physical",
  "Follow-up visit",
  "Skin check",
  "Blood pressure review",
  "Vaccination",
];

export async function seedDatabase(databaseUrl: string): Promise<string> {
  const connection = createDrizzleConnection(databaseUrl);
  try {
    await connection.db.transaction(async (transaction) => {
      await upsertDoctors(transaction);
      await replaceSchedules(transaction);
      await upsertPatients(transaction);
    });
  } finally {
    await connection.close();
  }
  const booked = await seedAppointments(databaseUrl);
  return `Seeded ${seedDoctors.length} doctors, ${seedPatients.length} patients, and ${booked} appointments.`;
}

type Transaction = Parameters<
  Parameters<ReturnType<typeof createDrizzleConnection>["db"]["transaction"]>[0]
>[0];

async function upsertDoctors(transaction: Transaction): Promise<void> {
  for (const doctor of seedDoctors) {
    await transaction
      .insert(doctors)
      .values(doctor)
      .onConflictDoUpdate({
        target: doctors.id,
        set: {
          fullName: doctor.fullName,
          specialty: doctor.specialty,
          timezone: doctor.timezone,
        },
      });
  }
}

async function replaceSchedules(transaction: Transaction): Promise<void> {
  const doctorIds = seedDoctors.map(({ id }) => id);
  await transaction
    .delete(availabilityRules)
    .where(inArray(availabilityRules.doctorId, doctorIds));
  await transaction.delete(timeOff).where(inArray(timeOff.doctorId, doctorIds));
  await transaction.insert(availabilityRules).values(seedRules);
  await transaction.insert(timeOff).values(seedTimeOff());
}

async function upsertPatients(transaction: Transaction): Promise<void> {
  for (const patient of seedPatients) {
    await transaction
      .insert(patients)
      .values(patient)
      .onConflictDoNothing({
        target: patients.phoneE164,
      });
  }
}

async function seedAppointments(databaseUrl: string): Promise<number> {
  // Real free slots from the slot engine guarantee every seeded booking is valid.
  const sql = createSqlClient(databaseUrl);
  const repository = new PostgresClinicRepository(sql);
  const now = new Date();
  const until = new Date(now.getTime() + SEEDED_DAYS * 24 * 60 * 60 * 1_000);
  const patientRows = await sql<{ id: string }[]>`
    SELECT id FROM patients
    WHERE full_name NOT IN ('Morgan Pastonly', 'Casey Noappt')
    ORDER BY full_name
  `;
  const pastPatient = (
    await sql<{ id: string }[]>`SELECT id FROM patients WHERE full_name = 'Morgan Pastonly' LIMIT 1`
  )[0];
  const futurePatient = (
    await sql<{ id: string }[]>`SELECT id FROM patients WHERE full_name = 'Jordan Future' LIMIT 1`
  )[0];

  let created = 0;
  try {
    for (const [doctorIndex, doctor] of seedDoctors.entries()) {
      const snapshot = await repository.loadAvailabilitySnapshot(
        doctor.id,
        now,
        until,
      );
      if (!snapshot) continue;
      const slots = getFreeSlots(snapshot, now, until, now);
      // A sparse, uneven pattern looks like a real week rather than a filled grid.
      const picks = [2, 5, 6, 11, 17, 23].map(
        (offset) => slots[offset + doctorIndex],
      );
      for (const [index, slot] of picks.entries()) {
        const patient =
          patientRows[(doctorIndex * 3 + index) % patientRows.length];
        if (!slot || !patient) continue;
        await repository.createAppointment({
          doctorId: doctor.id,
          patientId: patient.id,
          reason:
            SEED_REASONS[(doctorIndex + index) % SEED_REASONS.length] ??
            "Visit",
          idempotencyKey: `seed:${doctor.id}:${slot.start.toISOString()}`,
          calendarSyncStatus: "not_configured",
          time: slot,
        });
        created += 1;
      }
    }

    const firstDoctor = seedDoctors[0];
    if (firstDoctor && pastPatient) {
      const pastStart = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1_000);
      const pastEnd = new Date(pastStart.getTime() + 30 * 60 * 1_000);
      await sql`
        INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key, status, calendar_sync_status)
        VALUES (${firstDoctor.id}, ${pastPatient.id}, tstzrange(${pastStart}, ${pastEnd}, '[)'), 'Previous follow-up', ${`seed:past:${pastPatient.id}`}, 'completed', 'not_configured')
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      created += 1;
    }

    if (firstDoctor && futurePatient) {
      const futureStart = nextWeekdayAt(firstDoctor.timezone ?? "America/New_York", 3, 11);
      const futureEnd = new Date(futureStart.getTime() + 30 * 60 * 1_000);
      await sql`
        INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key, status, calendar_sync_status)
        VALUES (${firstDoctor.id}, ${futurePatient.id}, tstzrange(${futureStart}, ${futureEnd}, '[)'), 'Future consultation', ${`seed:future:${futurePatient.id}`}, 'booked', 'not_configured')
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      created += 1;
    }
  } finally {
    await sql.end();
  }
  return created;
}

function seedTimeOff() {
  return seedDoctors.map((doctor, index) => {
    const start = nextWeekdayAt(doctor.timezone, 9 + index, 12);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1_000);
    return {
      doctorId: doctor.id,
      timeSpan: `[${start.toISOString()},${end.toISOString()})`,
      reason: "Planned leave",
    };
  });
}

function nextWeekdayAt(
  timeZone: string,
  daysAhead: number,
  hour: number,
): Date {
  const localNow = TZDate.tz(timeZone, new Date());
  const result = TZDate.tz(
    timeZone,
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate(),
    hour,
  );
  result.setDate(result.getDate() + daysAhead);
  while (result.getDay() === 0 || result.getDay() === 6)
    result.setDate(result.getDate() + 1);
  return new Date(result.getTime());
}
