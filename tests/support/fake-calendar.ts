// Simulates an external calendar whose reads and writes can be failed independently.
// Events are keyed like Google's deterministic IDs so replayed writes stay observable.
import type {
  AvailabilitySource,
  BusyTimeResult,
  CalendarBooking,
  CalendarBookingResult,
  TimeInterval,
} from "@/domain/availability";

export class FakeCalendar implements AvailabilitySource {
  readonly busy: TimeInterval[] = [];
  readonly events = new Map<string, TimeInterval>();
  failReads = false;
  failWrites = false;
  writeCount = 0;

  constructor(private readonly clock: () => Date) {}

  async getBusyTimes(): Promise<BusyTimeResult> {
    if (this.failReads) throw new Error("Calendar read failed.");
    return { intervals: this.busy, retrievedAt: this.clock() };
  }

  async upsertBooking(
    booking: CalendarBooking,
  ): Promise<CalendarBookingResult> {
    this.recordWrite();
    const externalEventId = eventId(booking);
    this.events.set(externalEventId, booking.time);
    return { externalEventId };
  }

  async cancelBooking(booking: CalendarBooking): Promise<void> {
    this.recordWrite();
    this.events.delete(eventId(booking));
  }

  private recordWrite(): void {
    this.writeCount += 1;
    if (this.failWrites) throw new Error("Calendar write failed.");
  }
}

function eventId(booking: CalendarBooking): string {
  return booking.externalEventId ?? `event-${booking.appointmentId}`;
}
