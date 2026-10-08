// Exercises every voice tool through the real repository SQL, availability engine, and sync path.
// Only the external calendar is simulated, so its failures can be injected deterministically.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppointmentToolService } from "@/application/appointment-tool-service";
import { CalendarSync } from "@/application/calendar-sync";
import {
  IdempotencyConflictError,
  ToolBusinessError,
} from "@/application/errors";
import type { ToolResponse } from "@/application/tool-response";
import { PostgresClinicRepository } from "@/db/postgres-clinic-repository";
import { createAvailabilityService } from "@/domain/availability-service";

import { FakeCalendar } from "./support/fake-calendar";
import {
  connectDoctorCalendar,
  DOCTOR_ID,
  OTHER_PATIENT_ID,
  PATIENT_ID,
  startTestDatabase,
  type TestDatabase,
} from "./support/test-database";

// Monday 07:00 in New York; Tuesday's 09:00–11:00 local slots begin at 14:00 UTC.
const NOW = new Date("2027-01-11T12:00:00.000Z");
const TUESDAY_9AM = slot("2027-01-12T14:00:00.000Z");
const TUESDAY_930AM = slot("2027-01-12T14:30:00.000Z");

let database: TestDatabase;
let clock: Date;

beforeAll(async () => {
  database = await startTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  clock = NOW;
  await database.reset();
});

describe("find_patient", () => {
  it("verifies a patient by case-insensitive name and exact date of birth", async () => {
    const { service } = build();
    const result = await service.findPatient({
      full_name: "  alex MORGAN ",
      date_of_birth: "1988-04-12",
    });
    expect(result).toMatchObject({
      ok: true,
      data: { patient_id: PATIENT_ID },
    });
  });

  it("refuses a wrong date of birth", async () => {
    const { service } = build();
    const result = await service.findPatient({
      full_name: "Alex Morgan",
      date_of_birth: "1988-04-13",
    });
    expect(result.code).toBe("patient_not_verified");
  });

  it("refuses to pick between two patients sharing name and birth date", async () => {
    await database.sql`
      INSERT INTO patients (full_name, date_of_birth, phone_e164)
      VALUES ('Alex Morgan', '1988-04-12', '+15555550199')
    `;
    const { service } = build();
    const result = await service.findPatient({
      full_name: "Alex Morgan",
      date_of_birth: "1988-04-12",
    });
    expect(result.code).toBe("patient_not_verified");
  });
});

describe("list tools", () => {
  it("lists active doctors for the agent to resolve a name", async () => {
    const { service } = build();
    const result = await service.listDoctors({});
    expect(result).toMatchObject({
      code: "doctors_found",
      data: { doctors: [{ doctor_id: DOCTOR_ID, doctor_name: "Dr. Test" }] },
    });
  });

  it("lists only the patient's own upcoming booked appointments", async () => {
    const { service } = build();
    const mine = await service.bookAppointment(booking("key-list-mine"));
    await service.bookAppointment({
      ...booking("key-list-theirs"),
      patient_id: OTHER_PATIENT_ID,
      start_at: TUESDAY_930AM.start.toISOString(),
      end_at: TUESDAY_930AM.end.toISOString(),
    });
    const result = await service.listPatientAppointments({
      patient_id: PATIENT_ID,
    });
    const listed = (
      result.data as { appointments: { appointment_id: string }[] }
    ).appointments;
    expect(listed.map(({ appointment_id }) => appointment_id)).toEqual([
      appointmentIdOf(mine),
    ]);
    expect(result.message).toMatch(
      /Tuesday, January 12 at 9:00\sAM with Dr\. Test/,
    );
  });
});

describe("check_availability", () => {
  it("returns a bounded, chronological list with a speakable summary", async () => {
    const { service } = build();
    const result = await service.checkAvailability({
      specialty: "family medicine",
      start_at: NOW.toISOString(),
      end_at: "2027-01-18T00:00:00.000Z",
    });
    const slots = slotsOf(result);
    expect(slots).toHaveLength(6);
    expect(slots[0]?.start_at).toBe("2027-01-11T14:00:00.000Z");
    expect(slots.map(({ start_at }) => start_at)).toEqual(
      [...slots.map(({ start_at }) => start_at)].sort(),
    );
    expect(result.message).toMatch(
      /Monday, January 11 at 9:00\sAM with Dr\. Test/,
    );
  });

  it("subtracts external calendar busy time", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    calendar.busy.push(TUESDAY_9AM);
    const { service } = build(calendar);
    const slots = slotsOf(await service.checkAvailability(tuesdayWindow()));
    expect(slots.map(({ start_at }) => start_at)).not.toContain(
      TUESDAY_9AM.start.toISOString(),
    );
    expect(slots).toHaveLength(3);
  });

  it("fails closed when a configured calendar cannot be read", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    calendar.failReads = true;
    const { service } = build(calendar);
    await expect(
      service.checkAvailability(tuesdayWindow()),
    ).rejects.toMatchObject({ code: "calendar_unavailable", status: 503 });
  });

  it("fails closed when a calendar is configured but credentials are absent", async () => {
    await connectDoctorCalendar(database.sql);
    const { service } = build();
    await expect(
      service.checkAvailability(tuesdayWindow()),
    ).rejects.toBeInstanceOf(ToolBusinessError);
  });
});

describe("book_appointment", () => {
  it("books an offered slot", async () => {
    const { service } = build();
    const result = await service.bookAppointment(booking("key-booking-1"));
    expect(result).toMatchObject({
      ok: true,
      code: "appointment_booked",
      data: { status: "booked", calendar_sync_status: "not_configured" },
    });
  });

  it("returns the original appointment when a request is replayed", async () => {
    const { service } = build();
    const first = await service.bookAppointment(booking("key-replayed"));
    const replay = await service.bookAppointment(booking("key-replayed"));
    expect(replay.code).toBe("appointment_booked");
    expect(appointmentIdOf(replay)).toBe(appointmentIdOf(first));
    expect(await bookedCount()).toBe(1);
  });

  it("rejects a reused key carrying different appointment details", async () => {
    const { service } = build();
    await service.bookAppointment(booking("key-reused"));
    await expect(
      service.bookAppointment({ ...booking("key-reused"), reason: "Rash" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("offers alternatives when the slot is already booked", async () => {
    const { service } = build();
    await service.bookAppointment(booking("key-first"));
    const result = await service.bookAppointment({
      ...booking("key-second"),
      patient_id: OTHER_PATIENT_ID,
    });
    expect(result.code).toBe("slot_unavailable");
    expect(alternativesOf(result)[0]?.start_at).toBe(
      TUESDAY_930AM.start.toISOString(),
    );
  });

  it("rejects a time that is not on the doctor's schedule", async () => {
    const { service } = build();
    const result = await service.bookAppointment({
      ...booking("key-off-grid"),
      start_at: "2027-01-12T14:10:00.000Z",
      end_at: "2027-01-12T14:40:00.000Z",
    });
    expect(result.code).toBe("slot_unavailable");
  });

  it("lets exactly one of two racing callers win a slot", async () => {
    const { service } = build();
    const results = await Promise.all([
      service.bookAppointment(booking("key-race-a")),
      service.bookAppointment({
        ...booking("key-race-b"),
        patient_id: OTHER_PATIENT_ID,
      }),
    ]);
    expect(results.map(({ code }) => code).sort()).toEqual([
      "appointment_booked",
      "slot_unavailable",
    ]);
    expect(await bookedCount()).toBe(1);
  });

  it("mirrors the booking to the doctor's calendar", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    const { service } = build(calendar);
    const result = await service.bookAppointment(booking("key-synced"));
    expect(result.data).toMatchObject({ calendar_sync_status: "synced" });
    expect(calendar.events.size).toBe(1);
  });

  it("keeps the booking and reports pending sync when the calendar write fails", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    calendar.failWrites = true;
    const { service } = build(calendar);
    const result = await service.bookAppointment(booking("key-sync-fails"));
    expect(result).toMatchObject({
      ok: true,
      code: "appointment_booked_calendar_pending",
    });
    expect(await syncStatus(appointmentIdOf(result))).toBe("failed");
  });
});

describe("calendar reconciliation", () => {
  it("retries failed writes once the calendar recovers", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    calendar.failWrites = true;
    const { calendarSync, service } = build(calendar);
    const result = await service.bookAppointment(booking("key-reconcile"));

    calendar.failWrites = false;
    await database.sql`UPDATE appointments SET updated_at = now() - interval '5 minutes'`;
    expect(await calendarSync.reconcile()).toEqual({
      attempted: 1,
      synced: 1,
      failed: 0,
    });
    expect(await syncStatus(appointmentIdOf(result))).toBe("synced");
    expect(calendar.events.size).toBe(1);
  });

  it("leaves recently changed appointments to their in-flight request", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    calendar.failWrites = true;
    const { calendarSync, service } = build(calendar);
    await service.bookAppointment(booking("key-recent"));
    expect((await calendarSync.reconcile()).attempted).toBe(0);
  });
});

describe("reschedule_appointment", () => {
  it("moves the appointment and releases the original slot", async () => {
    const { service } = build();
    const booked = await service.bookAppointment(booking("key-move"));
    const moved = await service.rescheduleAppointment({
      appointment_id: appointmentIdOf(booked),
      patient_id: PATIENT_ID,
      start_at: TUESDAY_930AM.start.toISOString(),
      end_at: TUESDAY_930AM.end.toISOString(),
    });
    expect(moved.code).toBe("appointment_rescheduled");
    const open = slotsOf(await service.checkAvailability(tuesdayWindow()));
    expect(open.map(({ start_at }) => start_at)).toContain(
      TUESDAY_9AM.start.toISOString(),
    );
  });

  it("does not let one patient move another patient's appointment", async () => {
    const { service } = build();
    const booked = await service.bookAppointment(booking("key-owner"));
    const result = await service.rescheduleAppointment({
      appointment_id: appointmentIdOf(booked),
      patient_id: OTHER_PATIENT_ID,
      start_at: TUESDAY_930AM.start.toISOString(),
      end_at: TUESDAY_930AM.end.toISOString(),
    });
    expect(result.code).toBe("appointment_not_found");
  });

  it("refuses to move into a slot someone else holds", async () => {
    const { service } = build();
    const mine = await service.bookAppointment(booking("key-mine"));
    await service.bookAppointment({
      ...booking("key-theirs"),
      patient_id: OTHER_PATIENT_ID,
      start_at: TUESDAY_930AM.start.toISOString(),
      end_at: TUESDAY_930AM.end.toISOString(),
    });
    const result = await service.rescheduleAppointment({
      appointment_id: appointmentIdOf(mine),
      patient_id: PATIENT_ID,
      start_at: TUESDAY_930AM.start.toISOString(),
      end_at: TUESDAY_930AM.end.toISOString(),
    });
    expect(result.code).toBe("slot_unavailable");
  });
});

describe("cancel_appointment", () => {
  it("cancels idempotently and frees the slot for another patient", async () => {
    const { service } = build();
    const booked = await service.bookAppointment(booking("key-cancel"));
    const request = {
      appointment_id: appointmentIdOf(booked),
      patient_id: PATIENT_ID,
    };
    expect((await service.cancelAppointment(request)).code).toBe(
      "appointment_cancelled",
    );
    expect((await service.cancelAppointment(request)).code).toBe(
      "appointment_cancelled",
    );
    const rebooked = await service.bookAppointment({
      ...booking("key-rebook"),
      patient_id: OTHER_PATIENT_ID,
    });
    expect(rebooked.code).toBe("appointment_booked");
  });

  it("removes the mirrored calendar event", async () => {
    await connectDoctorCalendar(database.sql);
    const calendar = new FakeCalendar(() => clock);
    const { service } = build(calendar);
    const booked = await service.bookAppointment(booking("key-remove"));
    const result = await service.cancelAppointment({
      appointment_id: appointmentIdOf(booked),
      patient_id: PATIENT_ID,
    });
    expect(result.data).toMatchObject({ calendar_sync_status: "synced" });
    expect(calendar.events.size).toBe(0);
  });
});

function build(calendar?: FakeCalendar) {
  const repository = new PostgresClinicRepository(database.sql);
  const now = () => clock;
  const calendarSync = new CalendarSync(repository, calendar);
  const service = new AppointmentToolService({
    repository,
    calendarSync,
    clock: now,
    getSlots: createAvailabilityService(
      (doctorId, from, to) =>
        repository.loadAvailabilitySnapshot(doctorId, from, to),
      calendar,
    ),
  });
  return { calendarSync, service };
}

function booking(idempotencyKey: string) {
  return {
    doctor_id: DOCTOR_ID,
    patient_id: PATIENT_ID,
    reason: "Annual physical",
    idempotency_key: idempotencyKey,
    start_at: TUESDAY_9AM.start.toISOString(),
    end_at: TUESDAY_9AM.end.toISOString(),
  };
}

function tuesdayWindow() {
  return {
    doctor_id: DOCTOR_ID,
    start_at: "2027-01-12T00:00:00.000Z",
    end_at: "2027-01-13T00:00:00.000Z",
  };
}

function slot(start: string) {
  const startDate = new Date(start);
  return { start: startDate, end: new Date(startDate.getTime() + 30 * 60_000) };
}

type SlotData = { start_at: string }[];

function slotsOf(result: ToolResponse): SlotData {
  return (result.data as { slots?: SlotData } | undefined)?.slots ?? [];
}

function alternativesOf(result: ToolResponse): SlotData {
  return (
    (result.data as { alternatives?: SlotData } | undefined)?.alternatives ?? []
  );
}

function appointmentIdOf(result: ToolResponse): string {
  const id = (result.data as { appointment_id?: string } | undefined)
    ?.appointment_id;
  if (!id) throw new Error(`Expected an appointment in ${result.code}.`);
  return id;
}

async function bookedCount(): Promise<number> {
  const rows = await database.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM appointments WHERE status = 'booked'
  `;
  return rows[0]?.count ?? 0;
}

async function syncStatus(appointmentId: string): Promise<string | undefined> {
  const rows = await database.sql<{ calendar_sync_status: string }[]>`
    SELECT calendar_sync_status FROM appointments WHERE id = ${appointmentId}
  `;
  return rows[0]?.calendar_sync_status;
}
