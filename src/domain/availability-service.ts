// Coordinates database state and optional external-calendar busy time before slot calculation.
// Both sources sit behind injected functions, so this module never knows about SQL or HTTP.
import type { AvailabilitySource } from "./availability";
import {
  getFreeSlots,
  type AvailabilitySnapshot,
  type FreeSlot,
} from "./get-free-slots";

const CALENDAR_FRESHNESS_LIMIT_MS = 2 * 60 * 1_000;

export type SnapshotLoader = (
  doctorId: string,
  from: Date,
  to: Date,
) => Promise<AvailabilitySnapshot | null>;

export type GetSlots = (
  doctorId: string,
  from: Date,
  to: Date,
  now: Date,
) => Promise<FreeSlot[]>;

export class DoctorNotFoundError extends Error {
  constructor(doctorId: string) {
    super(`No active doctor was found with id ${doctorId}.`);
    this.name = "DoctorNotFoundError";
  }
}

export class CalendarUnavailableError extends Error {
  constructor() {
    super(
      "Live calendar availability is temporarily unavailable. Please try again shortly.",
    );
    this.name = "CalendarUnavailableError";
  }
}

export class StaleCalendarDataError extends CalendarUnavailableError {
  constructor() {
    super();
    this.name = "StaleCalendarDataError";
  }
}

export function createAvailabilityService(
  loadSnapshot: SnapshotLoader,
  calendar: AvailabilitySource | undefined,
): GetSlots {
  return async function getFreeSlotsForDoctor(doctorId, from, to, now) {
    const snapshot = await loadSnapshot(doctorId, from, to);
    if (!snapshot) throw new DoctorNotFoundError(doctorId);
    if (!snapshot.calendarConfigured)
      return getFreeSlots(snapshot, from, to, now);

    const calendarBusy = await getCurrentBusyTimes(
      calendar,
      doctorId,
      from,
      to,
      now,
    );
    return getFreeSlots({ ...snapshot, calendarBusy }, from, to, now);
  };
}

async function getCurrentBusyTimes(
  calendar: AvailabilitySource | undefined,
  doctorId: string,
  from: Date,
  to: Date,
  now: Date,
) {
  // A configured calendar that cannot be read must never be treated as empty.
  if (!calendar) throw new CalendarUnavailableError();
  let result;
  try {
    result = await calendar.getBusyTimes(doctorId, { start: from, end: to });
  } catch {
    throw new CalendarUnavailableError();
  }
  if (
    now.getTime() - result.retrievedAt.getTime() >
    CALENDAR_FRESHNESS_LIMIT_MS
  ) {
    throw new StaleCalendarDataError();
  }
  return result.intervals;
}
