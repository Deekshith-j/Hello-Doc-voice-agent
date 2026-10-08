// Describes the persistence operations used by appointment tool workflows.
// The interface keeps business logic testable without mocking SQL query builders.
import type { TimeInterval } from "@/domain/availability";

export type CalendarSyncStatus =
  "not_configured" | "pending" | "synced" | "failed";

export interface PatientRecord {
  fullName: string;
  id: string;
}

export interface DoctorRecord {
  externalCalendarId: string | null;
  fullName: string;
  id: string;
  specialty: string;
  timezone: string;
}

export interface AppointmentRecord {
  calendarSyncStatus: CalendarSyncStatus;
  doctorId: string;
  externalCalendarEventId: string | null;
  id: string;
  patientId: string;
  reason: string;
  status: "booked" | "cancelled" | "completed" | "no_show";
  time: TimeInterval;
}

export interface UpcomingAppointment extends AppointmentRecord {
  doctorName: string;
  doctorTimezone: string;
}

export interface CreateAppointmentInput {
  calendarSyncStatus: Extract<CalendarSyncStatus, "not_configured" | "pending">;
  doctorId: string;
  idempotencyKey: string;
  patientId: string;
  reason: string;
  time: TimeInterval;
}

export interface ClinicRepository {
  cancelAppointment(
    appointmentId: string,
    patientId: string,
  ): Promise<AppointmentRecord | null>;
  createAppointment(input: CreateAppointmentInput): Promise<AppointmentRecord>;
  findAppointment(
    appointmentId: string,
    patientId: string,
  ): Promise<AppointmentRecord | null>;
  findAppointmentById(appointmentId: string): Promise<AppointmentRecord | null>;
  findAppointmentByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<AppointmentRecord | null>;
  findConflictingAppointment(
    doctorId: string,
    time: TimeInterval,
  ): Promise<AppointmentRecord | null>;
  findDoctor(doctorId: string): Promise<DoctorRecord | null>;
  findDoctorsBySpecialty(specialty: string): Promise<DoctorRecord[]>;
  listDoctors(): Promise<DoctorRecord[]>;
  listUpcomingAppointments(
    patientId: string,
    from: Date,
    limit: number,
  ): Promise<UpcomingAppointment[]>;
  findPatient(patientId: string): Promise<PatientRecord | null>;
  findVerifiedPatient(
    fullName: string,
    dateOfBirth: string,
  ): Promise<PatientRecord | null>;
  listAppointmentsNeedingCalendarSync(
    minimumAgeSeconds: number,
    limit: number,
  ): Promise<AppointmentRecord[]>;
  markCalendarSync(
    appointmentId: string,
    status: CalendarSyncStatus,
    externalEventId?: string,
  ): Promise<void>;
  rescheduleAppointment(
    appointmentId: string,
    patientId: string,
    time: TimeInterval,
  ): Promise<AppointmentRecord | null>;
}
