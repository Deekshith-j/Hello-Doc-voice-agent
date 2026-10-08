// Mirrors committed Postgres appointments to the external calendar, inline or on retry.
// Postgres is the system of record, so sync failures are recorded and never undo a booking.
import type {
  AvailabilitySource,
  CalendarBooking,
} from "@/domain/availability";

import type {
  AppointmentRecord,
  CalendarSyncStatus,
  ClinicRepository,
} from "./clinic-repository";

const RECONCILE_BATCH_SIZE = 25;
// In-flight tool requests finish their own sync; the reconciler only claims older rows.
const RECONCILE_GRACE_PERIOD_SECONDS = 60;

export interface ReconcileSummary {
  attempted: number;
  failed: number;
  synced: number;
}

export class CalendarSync {
  constructor(
    private readonly repository: ClinicRepository,
    private readonly calendar: AvailabilitySource | undefined,
  ) {}

  async sync(appointment: AppointmentRecord): Promise<CalendarSyncStatus> {
    if (
      appointment.calendarSyncStatus === "not_configured" ||
      appointment.calendarSyncStatus === "synced"
    ) {
      return appointment.calendarSyncStatus;
    }
    try {
      const externalEventId = await this.write(appointment);
      await this.repository.markCalendarSync(
        appointment.id,
        "synced",
        externalEventId,
      );
      return "synced";
    } catch (error) {
      logSyncFailure(appointment.id, error);
      await this.repository.markCalendarSync(appointment.id, "failed");
      return "failed";
    }
  }

  async reconcile(): Promise<ReconcileSummary> {
    const appointments =
      await this.repository.listAppointmentsNeedingCalendarSync(
        RECONCILE_GRACE_PERIOD_SECONDS,
        RECONCILE_BATCH_SIZE,
      );
    const summary: ReconcileSummary = { attempted: 0, failed: 0, synced: 0 };
    // Sequential writes keep Google quota use predictable during a backlog.
    for (const appointment of appointments) {
      const status = await this.sync(appointment);
      summary.attempted += 1;
      if (status === "synced") summary.synced += 1;
      if (status === "failed") summary.failed += 1;
    }
    return summary;
  }

  private async write(
    appointment: AppointmentRecord,
  ): Promise<string | undefined> {
    if (!this.calendar)
      throw new Error("Calendar credentials are not configured.");
    const booking = toCalendarBooking(appointment);
    if (appointment.status === "cancelled") {
      await this.calendar.cancelBooking(booking);
      return undefined;
    }
    const result = await this.calendar.upsertBooking(booking);
    return result.externalEventId;
  }
}

function toCalendarBooking(appointment: AppointmentRecord): CalendarBooking {
  return {
    appointmentId: appointment.id,
    doctorId: appointment.doctorId,
    externalEventId: appointment.externalCalendarEventId,
    time: appointment.time,
  };
}

function logSyncFailure(appointmentId: string, error: unknown): void {
  // Only identifiers and error class are logged; calendar payloads may describe patients.
  console.warn(
    JSON.stringify({
      event: "calendar_sync",
      outcome: "failed",
      appointment_id: appointmentId,
      error: error instanceof Error ? error.name : "unknown",
    }),
  );
}
