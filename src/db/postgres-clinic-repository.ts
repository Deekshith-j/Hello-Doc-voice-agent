// Holds every runtime SQL statement behind explicit, reviewable PostgreSQL queries.
// Range construction stays in SQL so every write uses the same half-open convention.
import type { Sql } from "postgres";

import type {
  AppointmentRecord,
  CalendarSyncStatus,
  ClinicRepository,
  CreateAppointmentInput,
  DoctorRecord,
  PatientRecord,
  UpcomingAppointment,
} from "@/application/clinic-repository";
import type { TimeInterval } from "@/domain/availability";
import type { AvailabilitySnapshot } from "@/domain/get-free-slots";
import type { RateLimitStore } from "@/server/rate-limiter";

interface AppointmentRow {
  calendar_sync_status: CalendarSyncStatus;
  doctor_id: string;
  end_at: Date;
  external_calendar_event_id: string | null;
  id: string;
  patient_id: string;
  reason: string;
  start_at: Date;
  status: AppointmentRecord["status"];
}

interface RuleRow {
  day_of_week: number;
  end_time: string;
  slot_duration_minutes: number;
  start_time: string;
}

interface IntervalRow {
  end_at: Date;
  start_at: Date;
}

export class PostgresClinicRepository
  implements ClinicRepository, RateLimitStore
{
  constructor(private readonly sql: Sql) {}

  async ping(): Promise<void> {
    // A constant projection verifies connectivity without reading clinic or patient data.
    await this.sql`SELECT 1`;
  }

  async findVerifiedPatient(
    fullName: string,
    dateOfBirth: string,
  ): Promise<PatientRecord | null> {
    // Name plus DOB must identify exactly one person; an ambiguous match verifies no one.
    const rows = await this.sql<PatientRecord[]>`
      SELECT id, full_name AS "fullName"
      FROM patients
      WHERE lower(full_name) = lower(${fullName.trim()}) AND date_of_birth = ${dateOfBirth}
      LIMIT 2
    `;
    return rows.length === 1 ? (rows[0] ?? null) : null;
  }

  async findPatient(patientId: string): Promise<PatientRecord | null> {
    // Booking only needs existence and display name; DOB and phone stay out of later tool responses.
    const rows = await this.sql<PatientRecord[]>`
      SELECT id, full_name AS "fullName" FROM patients WHERE id = ${patientId}
    `;
    return rows[0] ?? null;
  }

  async findDoctor(doctorId: string): Promise<DoctorRecord | null> {
    // The primary-key lookup excludes inactive doctors before availability work begins.
    const rows = await this.sql<DoctorRecord[]>`
      SELECT id, full_name AS "fullName", specialty, timezone,
        external_calendar_id AS "externalCalendarId"
      FROM doctors WHERE id = ${doctorId} AND is_active = true
    `;
    return rows[0] ?? null;
  }

  async findDoctorsBySpecialty(specialty: string): Promise<DoctorRecord[]> {
    // Specialty search is the fallback when callers do not name a doctor.
    return this.sql<DoctorRecord[]>`
      SELECT id, full_name AS "fullName", specialty, timezone,
        external_calendar_id AS "externalCalendarId"
      FROM doctors
      WHERE lower(specialty) = lower(${specialty.trim()}) AND is_active = true
      ORDER BY full_name
    `;
  }

  async listDoctors(): Promise<DoctorRecord[]> {
    // The clinic roster is small; ordering by specialty groups doctors the way callers ask.
    return this.sql<DoctorRecord[]>`
      SELECT id, full_name AS "fullName", specialty, timezone,
        external_calendar_id AS "externalCalendarId"
      FROM doctors WHERE is_active = true
      ORDER BY specialty, full_name
    `;
  }

  async listUpcomingAppointments(
    patientId: string,
    from: Date,
    limit: number,
  ): Promise<UpcomingAppointment[]> {
    // The partial patient index holds only booked rows, so history never inflates this read.
    const rows = await this.sql<
      (AppointmentRow & { doctor_name: string; doctor_timezone: string })[]
    >`
      SELECT ${appointmentColumns(this.sql, "a")},
        d.full_name AS doctor_name, d.timezone AS doctor_timezone
      FROM appointments a JOIN doctors d ON d.id = a.doctor_id
      WHERE a.patient_id = ${patientId} AND a.status = 'booked'
        AND upper(a.time_span) > ${from}
      ORDER BY lower(a.time_span)
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      ...mapAppointment(row),
      doctorName: row.doctor_name,
      doctorTimezone: row.doctor_timezone,
    }));
  }

  async getCalendarId(doctorId: string): Promise<string | null> {
    // Calendar IDs are resolved server-side so tool inputs can never choose another calendar.
    const rows = await this.sql<{ external_calendar_id: string | null }[]>`
      SELECT external_calendar_id FROM doctors WHERE id = ${doctorId}
    `;
    return rows[0]?.external_calendar_id ?? null;
  }

  async loadAvailabilitySnapshot(
    doctorId: string,
    from: Date,
    to: Date,
  ): Promise<AvailabilitySnapshot | null> {
    // The primary-key lookup also checks activity so retired doctors never expose slots.
    const doctors = await this.sql<
      { external_calendar_id: string | null; timezone: string }[]
    >`
      SELECT timezone, external_calendar_id
      FROM doctors WHERE id = ${doctorId} AND is_active = true
    `;
    const doctor = doctors[0];
    if (!doctor) return null;

    const [rules, timeOff, booked] = await Promise.all([
      // The partial doctor/day index supplies only active rows.
      this.sql<RuleRow[]>`
        SELECT day_of_week, start_time::text, end_time::text, slot_duration_minutes
        FROM availability_rules
        WHERE doctor_id = ${doctorId} AND is_active = true
        ORDER BY day_of_week, start_time
      `,
      // GiST overlap avoids loading historical leave.
      this.sql<IntervalRow[]>`
        SELECT lower(time_span) AS start_at, upper(time_span) AS end_at
        FROM time_off
        WHERE doctor_id = ${doctorId} AND time_span && tstzrange(${from}, ${to}, '[)')
      `,
      // The exclusion constraint's GiST index answers the same overlap shape used during booking.
      this.sql<IntervalRow[]>`
        SELECT lower(time_span) AS start_at, upper(time_span) AS end_at
        FROM appointments
        WHERE doctor_id = ${doctorId} AND status = 'booked'
          AND time_span && tstzrange(${from}, ${to}, '[)')
      `,
    ]);
    return {
      doctorId,
      timeZone: doctor.timezone,
      calendarConfigured: doctor.external_calendar_id !== null,
      rules: rules.map((rule) => ({
        dayOfWeek: rule.day_of_week,
        startTime: rule.start_time.slice(0, 5),
        endTime: rule.end_time.slice(0, 5),
        slotDurationMinutes: rule.slot_duration_minutes,
      })),
      timeOff: timeOff.map(toInterval),
      booked: booked.map(toInterval),
    };
  }

  async createAppointment(
    input: CreateAppointmentInput,
  ): Promise<AppointmentRecord> {
    // A same-key race returns the winner's row atomically instead of inserting twice.
    const rows = await this.sql<AppointmentRow[]>`
      INSERT INTO appointments
        (doctor_id, patient_id, time_span, reason, idempotency_key, calendar_sync_status)
      VALUES (${input.doctorId}, ${input.patientId},
        tstzrange(${input.time.start}, ${input.time.end}, '[)'), ${input.reason},
        ${input.idempotencyKey}, ${input.calendarSyncStatus})
      ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING ${appointmentColumns(this.sql)}
    `;
    const row = rows[0];
    if (!row) throw new Error("The appointment insert returned no row.");
    return mapAppointment(row);
  }

  async findAppointment(
    id: string,
    patientId: string,
  ): Promise<AppointmentRecord | null> {
    // Pairing appointment and patient prevents one verified caller from reading another record.
    const rows = await this.sql<AppointmentRow[]>`
      SELECT ${appointmentColumns(this.sql)}
      FROM appointments WHERE id = ${id} AND patient_id = ${patientId}
    `;
    return rows[0] ? mapAppointment(rows[0]) : null;
  }

  async findAppointmentByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AppointmentRecord | null> {
    // The unique idempotency index makes replay detection a single index probe.
    const rows = await this.sql<AppointmentRow[]>`
      SELECT ${appointmentColumns(this.sql)}
      FROM appointments WHERE idempotency_key = ${idempotencyKey}
    `;
    return rows[0] ? mapAppointment(rows[0]) : null;
  }

  async rescheduleAppointment(
    id: string,
    patientId: string,
    time: TimeInterval,
  ): Promise<AppointmentRecord | null> {
    // A single update lets the exclusion constraint evaluate the replacement range atomically.
    const rows = await this.sql<AppointmentRow[]>`
      UPDATE appointments
      SET time_span = tstzrange(${time.start}, ${time.end}, '[)'),
        calendar_sync_status = ${pendingIfConfigured(this.sql)},
        updated_at = now()
      WHERE id = ${id} AND patient_id = ${patientId} AND status = 'booked'
      RETURNING ${appointmentColumns(this.sql)}
    `;
    return rows[0] ? mapAppointment(rows[0]) : null;
  }

  async cancelAppointment(
    id: string,
    patientId: string,
  ): Promise<AppointmentRecord | null> {
    // Cancellation changes status instead of deleting history and immediately releases the range.
    const rows = await this.sql<AppointmentRow[]>`
      UPDATE appointments
      SET status = 'cancelled', calendar_sync_status = ${pendingIfConfigured(this.sql)},
        updated_at = now()
      WHERE id = ${id} AND patient_id = ${patientId} AND status = 'booked'
      RETURNING ${appointmentColumns(this.sql)}
    `;
    return rows[0] ? mapAppointment(rows[0]) : null;
  }

  async markCalendarSync(
    appointmentId: string,
    status: CalendarSyncStatus,
    externalEventId?: string,
  ): Promise<void> {
    // COALESCE preserves the event ID when a later retry only changes sync state.
    await this.sql`
      UPDATE appointments
      SET calendar_sync_status = ${status},
        external_calendar_event_id = COALESCE(${externalEventId ?? null}, external_calendar_event_id),
        updated_at = now()
      WHERE id = ${appointmentId}
    `;
  }

  async listAppointmentsNeedingCalendarSync(
    minimumAgeSeconds: number,
    limit: number,
  ): Promise<AppointmentRecord[]> {
    // The database clock wrote updated_at, so it alone decides age; oldest-first prevents starvation.
    const rows = await this.sql<AppointmentRow[]>`
      SELECT ${appointmentColumns(this.sql)}
      FROM appointments
      WHERE calendar_sync_status IN ('pending', 'failed')
        AND updated_at < now() - make_interval(secs => ${minimumAgeSeconds})
      ORDER BY updated_at
      LIMIT ${limit}
    `;
    return rows.map(mapAppointment);
  }

  async incrementRateLimit(key: string, windowStart: Date): Promise<number> {
    // The CTE prunes this key's expired windows in the same round trip as the atomic increment.
    const rows = await this.sql<{ request_count: number }[]>`
      WITH pruned AS (
        DELETE FROM rate_limit_buckets WHERE key = ${key} AND window_start < ${windowStart}
      )
      INSERT INTO rate_limit_buckets (key, window_start, request_count)
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT (key, window_start) DO UPDATE
        SET request_count = rate_limit_buckets.request_count + 1
      RETURNING request_count
    `;
    const count = rows[0]?.request_count;
    if (count === undefined)
      throw new Error("The rate-limit upsert returned no row.");
    return count;
  }
}

function appointmentColumns(sql: Sql, alias?: string) {
  // A table alias is needed when the appointment row is joined with doctors.
  const t = alias ? sql`${sql(alias)}.` : sql``;
  return sql`${t}id, ${t}doctor_id, ${t}patient_id, ${t}reason, ${t}status,
    ${t}calendar_sync_status, ${t}external_calendar_event_id,
    lower(${t}time_span) AS start_at, upper(${t}time_span) AS end_at`;
}

function pendingIfConfigured(sql: Sql) {
  // Appointments for doctors without a calendar never enter the sync queue.
  return sql`CASE WHEN calendar_sync_status = 'not_configured'
    THEN 'not_configured'::calendar_sync_status ELSE 'pending'::calendar_sync_status END`;
}

function mapAppointment(row: AppointmentRow): AppointmentRecord {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    patientId: row.patient_id,
    reason: row.reason,
    status: row.status,
    calendarSyncStatus: row.calendar_sync_status,
    externalCalendarEventId: row.external_calendar_event_id,
    time: { start: row.start_at, end: row.end_at },
  };
}

function toInterval(row: IntervalRow): TimeInterval {
  return { start: row.start_at, end: row.end_at };
}
