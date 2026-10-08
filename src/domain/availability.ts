// Defines the boundary between clinic-owned availability and external calendars.
// Providers can fail independently, so callers receive freshness metadata with busy times.
export interface TimeInterval {
  end: Date;
  start: Date;
}

export interface BusyTimeResult {
  intervals: readonly TimeInterval[];
  retrievedAt: Date;
}

export interface CalendarBooking {
  appointmentId: string;
  doctorId: string;
  externalEventId: string | null;
  time: TimeInterval;
}

export interface CalendarBookingResult {
  externalEventId: string;
}

export interface AvailabilitySource {
  // Both writes must be idempotent: the reconciler replays them after ambiguous failures.
  cancelBooking(booking: CalendarBooking): Promise<void>;
  getBusyTimes(doctorId: string, window: TimeInterval): Promise<BusyTimeResult>;
  upsertBooking(booking: CalendarBooking): Promise<CalendarBookingResult>;
}
