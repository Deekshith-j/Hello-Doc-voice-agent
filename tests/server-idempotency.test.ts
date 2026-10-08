import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppointmentToolService } from "@/application/appointment-tool-service";
import { CalendarSync } from "@/application/calendar-sync";
import { deriveIdempotencyKey } from "@/app/api/tools/book-appointment/route";
import { PostgresClinicRepository } from "@/db/postgres-clinic-repository";
import { createAvailabilityService } from "@/domain/availability-service";
import { FakeCalendar } from "./support/fake-calendar";
import {
  DOCTOR_ID,
  OTHER_PATIENT_ID,
  PATIENT_ID,
  startTestDatabase,
  type TestDatabase,
} from "./support/test-database";

let database: TestDatabase;
let service: AppointmentToolService;

const NOW = new Date("2027-01-11T12:00:00.000Z");
const TUESDAY_9AM_START = "2027-01-12T14:00:00.000Z";
const TUESDAY_9AM_END = "2027-01-12T14:30:00.000Z";
const TUESDAY_930AM_START = "2027-01-12T14:30:00.000Z";
const TUESDAY_930AM_END = "2027-01-12T15:00:00.000Z";

beforeAll(async () => {
  database = await startTestDatabase();
  const repository = new PostgresClinicRepository(database.sql);
  const calendar = new FakeCalendar(() => NOW);
  const calendarSync = new CalendarSync(repository, calendar);
  const getSlots = createAvailabilityService(
    (doctorId, from, to) => repository.loadAvailabilitySnapshot(doctorId, from, to),
    calendar,
  );
  service = new AppointmentToolService({
    repository,
    getSlots,
    calendarSync,
    clock: () => NOW,
  });
});

beforeEach(async () => {
  await database.reset();
});

afterAll(async () => {
  await database.close();
});

describe("Server-derived idempotency", () => {
  it("derives deterministic hash from call_id, patient_id, doctor_id, start_at", () => {
    const key1 = deriveIdempotencyKey("call_abc", PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);
    const key2 = deriveIdempotencyKey("call_abc", PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);
    const diffSlot = deriveIdempotencyKey("call_abc", PATIENT_ID, DOCTOR_ID, TUESDAY_930AM_START);

    expect(key1).toBe(key2);
    expect(key1).not.toBe(diffSlot);
  });

  it("returns the same appointment row when the same call retries the booking", async () => {
    const callId = "call_retry_test";
    const key = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);

    const first = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "Annual Checkup",
      idempotency_key: key,
    });
    expect(first.ok).toBe(true);

    // Retried request with identical derived key
    const second = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "Annual Checkup",
      idempotency_key: key,
    });
    expect(second.ok).toBe(true);

    const firstData = first.data as { appointment_id: string };
    const secondData = second.data as { appointment_id: string };
    expect(firstData.appointment_id).toBe(secondData.appointment_id);

    // Verify exactly one row in DB
    const rows = await database.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM appointments`;
    expect(rows[0]?.count).toBe(1);
  });

  it("creates a second booking when the same call books a different slot", async () => {
    const callId = "call_multi_slot_test";
    const key1 = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);
    const key2 = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, TUESDAY_930AM_START);

    const first = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "First visit",
      idempotency_key: key1,
    });
    expect(first.ok).toBe(true);

    const second = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_930AM_START,
      end_at: TUESDAY_930AM_END,
      reason: "Second visit",
      idempotency_key: key2,
    });
    expect(second.ok).toBe(true);

    const firstData = first.data as { appointment_id: string };
    const secondData = second.data as { appointment_id: string };
    expect(firstData.appointment_id).not.toBe(secondData.appointment_id);

    // Verify two distinct rows in DB
    const rows = await database.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM appointments`;
    expect(rows[0]?.count).toBe(2);
  });

  it("different time formats for the same instant give one row", async () => {
    const callId = "call_format_test";
    const isoUtc = "2027-01-12T14:00:00.000Z";
    const isoOffset = "2027-01-12T09:00:00-05:00"; // Exact same instant in UTC

    const keyUtc = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, isoUtc);
    const keyOffset = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, isoOffset);
    expect(keyUtc).toBe(keyOffset);

    const first = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: isoUtc,
      end_at: TUESDAY_9AM_END,
      reason: "Timezone format check",
      idempotency_key: keyUtc,
    });
    expect(first.ok).toBe(true);

    const second = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: isoOffset,
      end_at: TUESDAY_9AM_END,
      reason: "Timezone format check",
      idempotency_key: keyOffset,
    });
    expect(second.ok).toBe(true);

    const firstData = first.data as { appointment_id: string };
    const secondData = second.data as { appointment_id: string };
    expect(firstData.appointment_id).toBe(secondData.appointment_id);

    const rows = await database.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM appointments`;
    expect(rows[0]?.count).toBe(1);
  });

  it("book, cancel, rebook the same slot in one call works and returns a BOOKED appointment, not the cancelled one", async () => {
    const callId = "call_rebook_cycle";
    const key = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);

    // 1. Book initial appointment
    const booked = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "First booking",
      idempotency_key: key,
    });
    expect(booked.ok).toBe(true);
    expect(booked.code).toBe("appointment_booked");
    const bookedData = booked.data as { appointment_id: string; status: string };
    expect(bookedData.status).toBe("booked");

    // 2. Cancel the appointment
    const cancelled = await service.cancelAppointment({
      appointment_id: bookedData.appointment_id,
      patient_id: PATIENT_ID,
    });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.code).toBe("appointment_cancelled");
    const cancelledData = cancelled.data as { status: string };
    expect(cancelledData.status).toBe("cancelled");

    // 3. Rebook the same slot in the same call
    const rebooked = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "Rebooking slot",
      idempotency_key: key,
    });
    expect(rebooked.ok).toBe(true);
    expect(rebooked.code).toBe("appointment_booked");
    const rebookedData = rebooked.data as { appointment_id: string; status: string };
    expect(rebookedData.status).toBe("booked");
    expect(rebookedData.status).not.toBe("cancelled");
  });

  it("returns appointment_booked when 23P01 occurs and conflicting appointment has same patient, doctor, and start", async () => {
    // Simulate concurrent race:
    // Insert winning booking for patient directly into database
    await database.sql`
      INSERT INTO appointments (doctor_id, patient_id, time_span, reason, idempotency_key, status)
      VALUES (${DOCTOR_ID}, ${PATIENT_ID}, tstzrange(${TUESDAY_9AM_START}::timestamptz, ${TUESDAY_9AM_END}::timestamptz, '[)'),
        'Winning booking', 'race_winner_key', 'booked')
    `;

    // Now a racing request from the same patient with a different idempotency key attempts insert
    // Mock getSlots to say slot was available (simulating pre-insert check before the race)
    const racingService = new AppointmentToolService({
      repository: new PostgresClinicRepository(database.sql),
      getSlots: async () => [{
        doctorId: DOCTOR_ID,
        start: new Date(TUESDAY_9AM_START),
        end: new Date(TUESDAY_9AM_END),
      }],
      calendarSync: new CalendarSync(new PostgresClinicRepository(database.sql), undefined),
      clock: () => NOW,
    });

    const result = await racingService.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "Racing caller same patient",
      idempotency_key: "racing_caller_key",
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("appointment_booked");
    const data = result.data as { status: string; patient_id?: string; doctor_id: string };
    expect(data.status).toBe("booked");
    expect(data.doctor_id).toBe(DOCTOR_ID);
  });

  it("book, reschedule, retry original book detects payload change and rejects with idempotency_key_reused", async () => {
    const callId = "call_reschedule_retry";
    const originalKey = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);

    // 1. Book original slot (9:00 AM)
    const booked = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "Initial visit",
      idempotency_key: originalKey,
    });
    expect(booked.ok).toBe(true);
    const bookedData = booked.data as { appointment_id: string };

    // 2. Reschedule to 9:30 AM
    const rescheduled = await service.rescheduleAppointment({
      appointment_id: bookedData.appointment_id,
      patient_id: PATIENT_ID,
      start_at: TUESDAY_930AM_START,
      end_at: TUESDAY_930AM_END,
    });
    expect(rescheduled.ok).toBe(true);
    expect(rescheduled.code).toBe("appointment_rescheduled");

    // 3. Retry original book request (slot 9:00 AM with originalKey)
    await expect(
      service.bookAppointment({
        patient_id: PATIENT_ID,
        doctor_id: DOCTOR_ID,
        start_at: TUESDAY_9AM_START,
        end_at: TUESDAY_9AM_END,
        reason: "Initial visit",
        idempotency_key: originalKey,
      }),
    ).rejects.toThrow(/That request key was already used/);
  });

  it("cancel, other patient books same slot, retry original rejects with slot_unavailable", async () => {
    const callId = "call_cancel_compete";
    const keyP1 = deriveIdempotencyKey(callId, PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);

    // 1. Patient 1 books slot
    const bookedP1 = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "P1 checkup",
      idempotency_key: keyP1,
    });
    expect(bookedP1.ok).toBe(true);
    const dataP1 = bookedP1.data as { appointment_id: string };

    // 2. Patient 1 cancels slot
    const cancelled = await service.cancelAppointment({
      appointment_id: dataP1.appointment_id,
      patient_id: PATIENT_ID,
    });
    expect(cancelled.ok).toBe(true);

    // 3. Other patient (Sam Rivera) books the same slot
    const keyP2 = deriveIdempotencyKey("call_other_patient", OTHER_PATIENT_ID, DOCTOR_ID, TUESDAY_9AM_START);
    const bookedP2 = await service.bookAppointment({
      patient_id: OTHER_PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "P2 checkup",
      idempotency_key: keyP2,
    });
    expect(bookedP2.ok).toBe(true);
    expect(bookedP2.code).toBe("appointment_booked");

    // 4. Patient 1 retries original book request
    const retryP1 = await service.bookAppointment({
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      start_at: TUESDAY_9AM_START,
      end_at: TUESDAY_9AM_END,
      reason: "P1 checkup",
      idempotency_key: keyP1,
    });
    expect(retryP1.ok).toBe(false);
    expect(retryP1.code).toBe("slot_unavailable");

    // Verify Patient 2's booking is untouched
    const p2Appts = await service.listPatientAppointments({ patient_id: OTHER_PATIENT_ID });
    expect(p2Appts.ok).toBe(true);
    const p2Data = p2Appts.data as { appointments: Array<{ id: string }> };
    expect(p2Data.appointments).toHaveLength(1);
  });
});
