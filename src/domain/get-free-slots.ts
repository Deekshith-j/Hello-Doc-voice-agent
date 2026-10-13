// WHAT: Expands recurring clinic operating hours into UTC slots and subtracts busy/time-off intervals.
// WHY: Booking logic requires pure, deterministic slot generation anchored in the doctor's wall-clock timezone.
// Translating local rules to absolute UTC avoids DST discrepancies (23h or 25h days) and guarantees timezone correctness.
import { TZDate } from "@date-fns/tz";

import type { TimeInterval } from "./availability";

const MINUTES_TO_MILLISECONDS = 60_000;
const TIME_PATTERN = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/;

interface WeeklyAvailabilityRule {
  dayOfWeek: number;
  endTime: string;
  slotDurationMinutes: number;
  startTime: string;
}

export interface AvailabilitySnapshot {
  booked: readonly TimeInterval[];
  calendarBusy?: readonly TimeInterval[];
  calendarConfigured?: boolean;
  doctorId: string;
  rules: readonly WeeklyAvailabilityRule[];
  timeOff: readonly TimeInterval[];
  timeZone: string;
}

interface LocalDate {
  day: number;
  monthIndex: number;
  year: number;
}

export interface FreeSlot extends TimeInterval {
  doctorId: string;
}

export function getFreeSlots(
  snapshot: AvailabilitySnapshot,
  from: Date,
  to: Date,
  now: Date,
): FreeSlot[] {
  assertValidWindow(from, to);
  const blocked = [
    ...snapshot.timeOff,
    ...snapshot.booked,
    ...(snapshot.calendarBusy ?? []),
  ];
  const slots = listLocalDates(from, to, snapshot.timeZone).flatMap((date) =>
    expandDate(snapshot, date),
  );

  return uniqueChronologicalSlots(slots).filter(
    (slot) =>
      slot.start >= from &&
      slot.end <= to &&
      slot.start >= now &&
      isFree(slot, blocked),
  );
}

function expandDate(
  snapshot: AvailabilitySnapshot,
  date: LocalDate,
): FreeSlot[] {
  const weekDay = new Date(
    Date.UTC(date.year, date.monthIndex, date.day),
  ).getUTCDay();
  return snapshot.rules
    .filter((rule) => rule.dayOfWeek === weekDay)
    .flatMap((rule) =>
      expandRule(snapshot.doctorId, snapshot.timeZone, date, rule),
    );
}

function expandRule(
  doctorId: string,
  timeZone: string,
  date: LocalDate,
  rule: WeeklyAvailabilityRule,
): FreeSlot[] {
  if (
    !Number.isInteger(rule.slotDurationMinutes) ||
    rule.slotDurationMinutes <= 0
  ) {
    throw new Error(
      "Slot duration must be a positive whole number of minutes.",
    );
  }
  const start = localInstant(date, rule.startTime, timeZone);
  const end = localInstant(date, rule.endTime, timeZone);
  if (start === null || end === null) return [];

  const durationMs = rule.slotDurationMinutes * MINUTES_TO_MILLISECONDS;
  return buildSlots(doctorId, start, end, durationMs);
}

function buildSlots(
  doctorId: string,
  start: Date,
  end: Date,
  durationMs: number,
): FreeSlot[] {
  const slots: FreeSlot[] = [];
  for (
    let cursor = start.getTime();
    cursor + durationMs <= end.getTime();
    cursor += durationMs
  ) {
    slots.push({
      doctorId,
      start: new Date(cursor),
      end: new Date(cursor + durationMs),
    });
  }
  return slots;
}

// WHY LOCAL DATE ENUMERATION:
// Clinic operating rules (e.g. "Mondays 9am-5pm") exist exclusively in the doctor's wall-clock timezone.
// Iterating by 24-hour UTC intervals would cross local midnight boundaries unevenly and fail during DST transitions
// (where local days have 23 or 25 hours). We enumerate discrete calendar dates (year, month, day) in the doctor's
// timezone first, then map each rule to absolute UTC instants.
function listLocalDates(from: Date, to: Date, timeZone: string): LocalDate[] {
  const first = localDateParts(from, timeZone);
  const last = localDateParts(new Date(to.getTime() - 1), timeZone);
  const cursor = new Date(Date.UTC(first.year, first.monthIndex, first.day));
  const lastValue = Date.UTC(last.year, last.monthIndex, last.day);
  const dates: LocalDate[] = [];

  while (cursor.getTime() <= lastValue) {
    dates.push({
      year: cursor.getUTCFullYear(),
      monthIndex: cursor.getUTCMonth(),
      day: cursor.getUTCDate(),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function localDateParts(instant: Date, timeZone: string): LocalDate {
  const zoned = new TZDate(instant, timeZone);
  return {
    year: zoned.getFullYear(),
    monthIndex: zoned.getMonth(),
    day: zoned.getDate(),
  };
}

// WHY DST VALIDATION:
// During "spring forward" DST transitions, a wall-clock hour ceases to exist (e.g., 2:00 AM -> 3:00 AM).
// Standard JS Date constructors or naive math will silently coerce invalid wall times into the adjacent hour,
// offering phantom slots to callers. Checking that `zoned.getHours() === hour` and `zoned.getMinutes() === minute`
// guarantees that nonexistent wall-clock times return null and are safely dropped.
// During "fall back", the ambiguous hour is resolved deterministically by TZDate to the standard offset.
function localInstant(
  date: LocalDate,
  time: string,
  timeZone: string,
): Date | null {
  const parsed = TIME_PATTERN.exec(time)?.groups;
  if (!parsed) throw new Error(`Invalid local time: ${time}`);
  const hour = Number(parsed.hour);
  const minute = Number(parsed.minute);
  const zoned = TZDate.tz(
    timeZone,
    date.year,
    date.monthIndex,
    date.day,
    hour,
    minute,
  );

  // Spring-forward wall times do not exist; silently normalizing would advertise a wrong slot.
  if (zoned.getHours() !== hour || zoned.getMinutes() !== minute) return null;
  return new Date(zoned.getTime());
}

function isFree(slot: TimeInterval, blocked: readonly TimeInterval[]): boolean {
  return blocked.every((interval) => !overlaps(slot, interval));
}

// WHY HALF-OPEN INTERVAL OVERLAPS:
// Clinical bookings are half-open intervals [start, end). An appointment ending at 10:30 AM
// leaves the doctor immediately free to start the next appointment at 10:30 AM.
// Standard overlap logic `left.start < right.end && right.start < left.end` treats abutting intervals as non-overlapping.
function overlaps(left: TimeInterval, right: TimeInterval): boolean {
  return left.start < right.end && right.start < left.end;
}

function uniqueChronologicalSlots(slots: readonly FreeSlot[]): FreeSlot[] {
  const byStart = new Map(
    slots.map((slot) => [slot.start.toISOString(), slot]),
  );
  return [...byStart.values()].sort(
    (left, right) => left.start.getTime() - right.start.getTime(),
  );
}

function assertValidWindow(from: Date, to: Date): void {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to
  ) {
    throw new Error(
      "Availability window must have valid dates with 'from' before 'to'.",
    );
  }
}
