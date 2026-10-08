// Verifies the pure slot engine at timezone, boundary, and conflict edges.
// Explicit clocks keep the suite deterministic regardless of when or where it runs.
import { expect, it } from "vitest";

import {
  getFreeSlots,
  type AvailabilitySnapshot,
} from "@/domain/get-free-slots";

const DOCTOR_ID = "10000000-0000-4000-8000-000000000001";
const BEFORE_ALL_SLOTS = new Date("2026-01-01T00:00:00.000Z");

it("uses the doctor's changing UTC offset across daylight saving time", () => {
  const snapshot = schedule({
    dayOfWeek: 0,
    startTime: "09:00",
    endTime: "09:30",
  });
  const slots = getFreeSlots(
    snapshot,
    new Date("2026-03-01T00:00:00.000Z"),
    new Date("2026-03-09T23:59:59.000Z"),
    BEFORE_ALL_SLOTS,
  );

  expect(slots.map(({ start }) => start.toISOString())).toEqual([
    "2026-03-01T14:00:00.000Z",
    "2026-03-08T13:00:00.000Z",
  ]);
});

it("drops nonexistent local times during the spring-forward gap", () => {
  const snapshot = schedule({
    dayOfWeek: 0,
    startTime: "02:00",
    endTime: "03:00",
  });
  const slots = getFreeSlots(
    snapshot,
    new Date("2026-03-08T00:00:00.000Z"),
    new Date("2026-03-09T00:00:00.000Z"),
    BEFORE_ALL_SLOTS,
  );

  expect(slots).toEqual([]);
});

it("removes every slot touched by a partially overlapping appointment", () => {
  const snapshot = schedule(
    { dayOfWeek: 1, startTime: "09:00", endTime: "11:00" },
    { booked: [interval("2026-02-02T14:15:00Z", "2026-02-02T14:45:00Z")] },
  );
  const slots = slotsOn(snapshot, "2026-02-02");

  expect(slots.map(({ start }) => start.toISOString())).toEqual([
    "2026-02-02T15:00:00.000Z",
    "2026-02-02T15:30:00.000Z",
  ]);
});

it("subtracts doctor time off", () => {
  const snapshot = schedule(
    { dayOfWeek: 1, startTime: "09:00", endTime: "11:00" },
    { timeOff: [interval("2026-02-02T14:30:00Z", "2026-02-02T15:30:00Z")] },
  );

  expect(slotsOn(snapshot, "2026-02-02")).toHaveLength(2);
  expect(slotsOn(snapshot, "2026-02-02")[1]?.start.toISOString()).toBe(
    "2026-02-02T15:30:00.000Z",
  );
});

it("includes the last slot whose end exactly matches closing time", () => {
  const snapshot = schedule({
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "11:00",
  });
  const slots = slotsOn(snapshot, "2026-02-02");

  expect(slots.at(-1)).toMatchObject({
    start: new Date("2026-02-02T15:30:00.000Z"),
    end: new Date("2026-02-02T16:00:00.000Z"),
  });
});

it("drops slots that started before the supplied clock", () => {
  const snapshot = schedule({
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "11:00",
  });
  const slots = getFreeSlots(
    snapshot,
    new Date("2026-02-02T00:00:00.000Z"),
    new Date("2026-02-03T00:00:00.000Z"),
    new Date("2026-02-02T15:00:00.000Z"),
  );

  expect(slots.map(({ start }) => start.toISOString())).toEqual([
    "2026-02-02T15:00:00.000Z",
    "2026-02-02T15:30:00.000Z",
  ]);
});

it("merges external-calendar busy times with clinic-owned conflicts", () => {
  const snapshot = schedule(
    { dayOfWeek: 1, startTime: "09:00", endTime: "10:30" },
    {
      calendarBusy: [interval("2026-02-02T14:30:00Z", "2026-02-02T15:00:00Z")],
    },
  );

  expect(slotsOn(snapshot, "2026-02-02")).toHaveLength(2);
});

function schedule(
  rule: Omit<AvailabilitySnapshot["rules"][number], "slotDurationMinutes">,
  overrides: Partial<AvailabilitySnapshot> = {},
): AvailabilitySnapshot {
  return {
    doctorId: DOCTOR_ID,
    timeZone: "America/New_York",
    rules: [{ ...rule, slotDurationMinutes: 30 }],
    booked: [],
    timeOff: [],
    ...overrides,
  };
}

function slotsOn(snapshot: AvailabilitySnapshot, date: string) {
  return getFreeSlots(
    snapshot,
    new Date(`${date}T00:00:00.000Z`),
    new Date(`${date}T23:59:59.999Z`),
    BEFORE_ALL_SLOTS,
  );
}

function interval(start: string, end: string) {
  return { start: new Date(start), end: new Date(end) };
}
