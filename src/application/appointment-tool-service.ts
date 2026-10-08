// Implements the five voice-agent tools independently of HTTP and Retell transport details.
// Every outcome includes concise prose the agent can safely read to a caller.
import type { TimeInterval } from "@/domain/availability";
import {
  CalendarUnavailableError,
  DoctorNotFoundError,
  type GetSlots,
} from "@/domain/availability-service";
import type { FreeSlot } from "@/domain/get-free-slots";

import type { CalendarSync } from "./calendar-sync";
import type {
  AppointmentRecord,
  CalendarSyncStatus,
  ClinicRepository,
  DoctorRecord,
} from "./clinic-repository";
import {
  getPostgresErrorCode,
  IdempotencyConflictError,
  ToolBusinessError,
} from "./errors";
import { toolFailure, type ToolResponse, toolSuccess } from "./tool-response";
import type {
  BookAppointmentInput,
  CancelAppointmentInput,
  CheckAvailabilityInput,
  FindPatientInput,
  ListDoctorsInput,
  ListPatientAppointmentsInput,
  RescheduleAppointmentInput,
} from "./tool-schemas";

const MAX_RETURNED_SLOTS = 6;
const MAX_SPOKEN_SLOTS = 3;
const MAX_LISTED_APPOINTMENTS = 5;
const ALTERNATIVE_SEARCH_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;
const EXCLUSION_VIOLATION = "23P01";

type AppointmentVerb = "booked" | "rescheduled" | "cancelled";

export interface AppointmentToolDependencies {
  calendarSync: CalendarSync;
  clock?: () => Date;
  getSlots: GetSlots;
  repository: ClinicRepository;
}

export interface OfferedSlot {
  doctor_id: string;
  doctor_name: string;
  end_at: string;
  start_at: string;
  timezone: string;
  when: string;
}

export class AppointmentToolService {
  private readonly clock: () => Date;
  private readonly repository: ClinicRepository;

  constructor(private readonly dependencies: AppointmentToolDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.repository = dependencies.repository;
  }

  async listDoctors(input: ListDoctorsInput): Promise<ToolResponse> {
    const doctors = input.specialty
      ? await this.repository.findDoctorsBySpecialty(input.specialty)
      : await this.repository.listDoctors();
    if (doctors.length === 0) return doctorNotFound();
    const names = doctors.map(
      (doctor) => `${doctor.fullName} in ${doctor.specialty}`,
    );
    return toolSuccess(
      "doctors_found",
      `Our doctors are ${names.join(", ")}.`,
      {
        doctors: doctors.map((doctor) => ({
          doctor_id: doctor.id,
          doctor_name: doctor.fullName,
          specialty: doctor.specialty,
        })),
      },
    );
  }

  async listPatientAppointments(
    input: ListPatientAppointmentsInput,
  ): Promise<ToolResponse> {
    const appointments = await this.repository.listUpcomingAppointments(
      input.patient_id,
      this.clock(),
      MAX_LISTED_APPOINTMENTS,
    );
    if (appointments.length === 0) {
      return toolFailure(
        "no_upcoming_appointments",
        "I don't see any upcoming appointments for this patient.",
      );
    }
    const spoken = appointments.map(
      (appointment) =>
        `${spokenTime(appointment.time.start, appointment.doctorTimezone)} with ${appointment.doctorName}`,
    );
    return toolSuccess(
      "appointments_found",
      `I found ${appointments.length} upcoming appointment${appointments.length === 1 ? "" : "s"}: ${spoken.join("; ")}.`,
      {
        appointments: appointments.map((appointment) => ({
          appointment_id: appointment.id,
          doctor_name: appointment.doctorName,
          reason: appointment.reason,
          when: spokenTime(appointment.time.start, appointment.doctorTimezone),
          start_at: appointment.time.start.toISOString(),
          end_at: appointment.time.end.toISOString(),
        })),
      },
    );
  }

  async findPatient(input: FindPatientInput): Promise<ToolResponse> {
    const patient = await this.repository.findVerifiedPatient(
      input.full_name,
      input.date_of_birth,
    );
    if (!patient) {
      return toolFailure(
        "patient_not_verified",
        "I couldn't verify a patient with that name and date of birth. Please check both details.",
      );
    }
    return toolSuccess(
      "patient_verified",
      "Thank you. I verified the patient record.",
      { patient_id: patient.id, patient_name: patient.fullName },
    );
  }

  async checkAvailability(
    input: CheckAvailabilityInput,
  ): Promise<ToolResponse> {
    const doctors = await this.resolveDoctors(input);
    if (doctors.length === 0) return doctorNotFound();
    const slots = await this.getOfferedSlots(
      doctors,
      new Date(input.start_at),
      new Date(input.end_at),
    );
    if (slots.length === 0) {
      return toolFailure(
        "no_availability",
        "There aren't any available appointments in that time range.",
      );
    }
    return toolSuccess(
      "availability_found",
      `I found ${slots.length} available time${slots.length === 1 ? "" : "s"}. The first options are ${spokenSlots(slots)}.`,
      { slots },
    );
  }

  async bookAppointment(input: BookAppointmentInput): Promise<ToolResponse> {
    const [patient, doctor] = await Promise.all([
      this.repository.findPatient(input.patient_id),
      this.repository.findDoctor(input.doctor_id),
    ]);
    if (!patient)
      return toolFailure(
        "patient_not_found",
        "I couldn't verify that patient record.",
      );
    if (!doctor) return doctorNotFound();
    const time = inputTime(input);

    // Replays must run before the availability check, which would see this booking as a conflict.
    const replay = await this.repository.findAppointmentByIdempotencyKey(
      input.idempotency_key,
    );
    if (replay && replay.status === "booked") {
      assertSameBooking(replay, input, time);
      return this.respond("booked", replay, doctor);
    }

    const unavailable = await this.rejectUnavailableSlot(doctor, time);
    if (unavailable) return unavailable;
    try {
      const appointment = await this.repository.createAppointment({
        calendarSyncStatus: doctor.externalCalendarId
          ? "pending"
          : "not_configured",
        doctorId: doctor.id,
        idempotencyKey: input.idempotency_key,
        patientId: patient.id,
        reason: input.reason,
        time,
      });
      // A concurrent request with the same key may have won the insert.
      assertSameBooking(appointment, input, time);
      return this.respond("booked", appointment, doctor);
    } catch (error) {
      if (getPostgresErrorCode(error) !== EXCLUSION_VIOLATION) throw error;
      const conflicting = await this.repository.findConflictingAppointment(
        doctor.id,
        time,
      );
      if (
        conflicting &&
        conflicting.status === "booked" &&
        conflicting.patientId === patient.id &&
        conflicting.doctorId === doctor.id &&
        conflicting.time.start.getTime() === time.start.getTime()
      ) {
        return this.respond("booked", conflicting, doctor);
      }
      return this.slotTakenResponse(doctor, time);
    }
  }

  async rescheduleAppointment(
    input: RescheduleAppointmentInput,
  ): Promise<ToolResponse> {
    const existing = await this.repository.findAppointment(
      input.appointment_id,
      input.patient_id,
    );
    if (!existing || existing.status !== "booked") return appointmentNotFound();
    const doctor = await this.repository.findDoctor(existing.doctorId);
    if (!doctor)
      return toolFailure(
        "doctor_not_found",
        "The appointment's doctor is no longer accepting bookings.",
      );
    const time = inputTime(input);
    if (sameTime(existing.time, time))
      return this.respond("rescheduled", existing, doctor);

    const unavailable = await this.rejectUnavailableSlot(doctor, time);
    if (unavailable) return unavailable;
    try {
      const moved = await this.repository.rescheduleAppointment(
        existing.id,
        existing.patientId,
        time,
      );
      if (!moved) return appointmentNotFound();
      return this.respond("rescheduled", moved, doctor);
    } catch (error) {
      if (getPostgresErrorCode(error) !== EXCLUSION_VIOLATION) throw error;
      return this.slotTakenResponse(doctor, time);
    }
  }

  async cancelAppointment(
    input: CancelAppointmentInput,
  ): Promise<ToolResponse> {
    const existing = await this.repository.findAppointment(
      input.appointment_id,
      input.patient_id,
    );
    // A repeated cancellation is a success, and also retries any unfinished calendar removal.
    if (existing?.status === "cancelled")
      return this.respond("cancelled", existing);
    if (existing?.status !== "booked") return appointmentNotFound();

    const cancelled = await this.repository.cancelAppointment(
      existing.id,
      existing.patientId,
    );
    if (!cancelled) return appointmentNotFound();
    return this.respond("cancelled", cancelled);
  }

  private async resolveDoctors(
    input: CheckAvailabilityInput,
  ): Promise<DoctorRecord[]> {
    if (input.doctor_id) {
      const doctor = await this.repository.findDoctor(input.doctor_id);
      return doctor ? [doctor] : [];
    }
    return this.repository.findDoctorsBySpecialty(input.specialty ?? "");
  }

  private async getOfferedSlots(
    doctors: readonly DoctorRecord[],
    from: Date,
    to: Date,
  ): Promise<OfferedSlot[]> {
    const now = this.clock();
    try {
      const groups = await Promise.all(
        doctors.map(async (doctor) => {
          const slots = await this.dependencies.getSlots(
            doctor.id,
            from,
            to,
            now,
          );
          return slots.map((slot) => offeredSlot(doctor, slot));
        }),
      );
      return groups.flat().sort(byStartTime).slice(0, MAX_RETURNED_SLOTS);
    } catch (error) {
      if (error instanceof CalendarUnavailableError)
        throw new ToolBusinessError("calendar_unavailable", error.message, 503);
      if (error instanceof DoctorNotFoundError)
        throw new ToolBusinessError(
          "doctor_not_found",
          "I couldn't find an active doctor matching that request.",
          404,
        );
      throw error;
    }
  }

  private async rejectUnavailableSlot(
    doctor: DoctorRecord,
    time: TimeInterval,
  ): Promise<ToolResponse | null> {
    const slots = await this.getOfferedSlots([doctor], time.start, time.end);
    const offered = slots.some(
      (slot) =>
        slot.start_at === time.start.toISOString() &&
        slot.end_at === time.end.toISOString(),
    );
    return offered ? null : this.slotTakenResponse(doctor, time);
  }

  private async slotTakenResponse(
    doctor: DoctorRecord,
    requested: TimeInterval,
  ): Promise<ToolResponse> {
    const from = new Date(
      Math.max(this.clock().getTime(), requested.start.getTime()),
    );
    const to = new Date(from.getTime() + ALTERNATIVE_SEARCH_DAYS * DAY_MS);
    const alternatives = await this.getOfferedSlots([doctor], from, to);
    const message = alternatives.length
      ? `That time isn't available. I can offer ${spokenSlots(alternatives)} instead.`
      : "That time isn't available, and I couldn't find another opening in the following week.";
    return toolFailure("slot_unavailable", message, {
      alternatives: alternatives.slice(0, MAX_SPOKEN_SLOTS),
    });
  }

  private async respond(
    verb: AppointmentVerb,
    appointment: AppointmentRecord,
    doctor?: DoctorRecord,
  ): Promise<ToolResponse> {
    const calendarSyncStatus =
      appointment.status === "booked" || appointment.status === "cancelled"
        ? await this.dependencies.calendarSync.sync(appointment)
        : appointment.calendarSyncStatus;
    const data = appointmentData(
      { ...appointment, calendarSyncStatus },
      doctor,
    );
    if (calendarSyncStatus === "failed") {
      return toolSuccess(
        `appointment_${verb}_calendar_pending`,
        `The appointment is ${verb} in the clinic's system. The doctor's calendar will update shortly.`,
        data,
      );
    }
    return toolSuccess(
      `appointment_${verb}`,
      `The appointment is ${verb}.`,
      data,
    );
  }

  async retryCalendarSync(
    appointmentId: string,
  ): Promise<CalendarSyncStatus | null> {
    const appointment = await this.repository.findAppointmentById(appointmentId);
    if (!appointment) return null;
    return this.dependencies.calendarSync.sync(appointment);
  }
}

function offeredSlot(doctor: DoctorRecord, slot: FreeSlot): OfferedSlot {
  return {
    doctor_id: doctor.id,
    doctor_name: doctor.fullName,
    timezone: doctor.timezone,
    start_at: slot.start.toISOString(),
    end_at: slot.end.toISOString(),
    when: spokenTime(slot.start, doctor.timezone),
  };
}

function spokenSlots(slots: readonly OfferedSlot[]): string {
  return slots.slice(0, MAX_SPOKEN_SLOTS).map(formatOfferedSlot).join(", or ");
}

function formatOfferedSlot(slot: OfferedSlot): string {
  return `${spokenTime(new Date(slot.start_at), slot.timezone)} with ${slot.doctor_name}`;
}

function spokenTime(instant: Date, timeZone: string): string {
  // The doctor's timezone is the clinic's wall clock for that appointment.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

function inputTime(input: { start_at: string; end_at: string }): TimeInterval {
  return { start: new Date(input.start_at), end: new Date(input.end_at) };
}

function sameTime(left: TimeInterval, right: TimeInterval): boolean {
  return (
    left.start.getTime() === right.start.getTime() &&
    left.end.getTime() === right.end.getTime()
  );
}

function assertSameBooking(
  existing: AppointmentRecord,
  input: BookAppointmentInput,
  time: TimeInterval,
): void {
  const same =
    existing.doctorId === input.doctor_id &&
    existing.patientId === input.patient_id &&
    existing.reason === input.reason &&
    sameTime(existing.time, time);
  if (!same) throw new IdempotencyConflictError();
}

function doctorNotFound(): ToolResponse {
  return toolFailure(
    "doctor_not_found",
    "I couldn't find an active doctor matching that request.",
  );
}

function appointmentNotFound(): ToolResponse {
  return toolFailure(
    "appointment_not_found",
    "I couldn't find an active appointment matching those details.",
  );
}

function appointmentData(
  appointment: AppointmentRecord,
  doctor?: DoctorRecord,
) {
  return {
    appointment_id: appointment.id,
    doctor_id: appointment.doctorId,
    ...(doctor
      ? {
          doctor_name: doctor.fullName,
          when: spokenTime(appointment.time.start, doctor.timezone),
        }
      : {}),
    start_at: appointment.time.start.toISOString(),
    end_at: appointment.time.end.toISOString(),
    status: appointment.status,
    calendar_sync_status: appointment.calendarSyncStatus,
  };
}

function byStartTime(left: OfferedSlot, right: OfferedSlot): number {
  return left.start_at.localeCompare(right.start_at);
}
