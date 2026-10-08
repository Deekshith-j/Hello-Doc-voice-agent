// Validates every voice-agent tool payload before it reaches business or database code.
// Field descriptions double as the agent's tool documentation, so the contract has one source.
import { z } from "zod";

const MAX_SEARCH_DAYS = 14;
const isoDateTime = z.iso.datetime({ offset: true });
const appointmentWindow = {
  end_at: isoDateTime.describe(
    "Window end as ISO 8601 with offset, e.g. 2027-01-12T17:00:00-05:00.",
  ),
  start_at: isoDateTime.describe(
    "Window start as ISO 8601 with offset, e.g. 2027-01-12T09:00:00-05:00.",
  ),
};
const slotTimes = {
  end_at: isoDateTime.describe("The chosen slot's end_at, copied exactly."),
  start_at: isoDateTime.describe("The chosen slot's start_at, copied exactly."),
};
const patientId = z
  .uuid()
  .describe("patient_id returned by find_patient for this caller.");
const appointmentId = z
  .uuid()
  .describe("appointment_id returned by list_patient_appointments.");

export const listDoctorsSchema = z
  .object({
    specialty: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .describe("Optional specialty filter, e.g. Cardiology."),
  })
  .strict();

export const findPatientSchema = z
  .object({
    date_of_birth: z.iso
      .date()
      .describe("Caller's date of birth as YYYY-MM-DD."),
    full_name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .describe("Caller's full name as they said it."),
  })
  .strict();

export const checkAvailabilitySchema = z
  .object({
    doctor_id: z
      .uuid()
      .optional()
      .describe("A doctor_id from list_doctors. Omit when using specialty."),
    specialty: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .describe(
        "Search every doctor in this specialty. Omit when using doctor_id.",
      ),
    ...appointmentWindow,
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.doctor_id) === Boolean(value.specialty)) {
      context.addIssue({
        code: "custom",
        message: "Provide either doctor_id or specialty, but not both.",
      });
    }
    validateWindow(value, context, MAX_SEARCH_DAYS);
  });

export const bookAppointmentSchema = z
  .object({
    doctor_id: z.uuid().describe("The chosen slot's doctor_id."),
    // Optional for the agent: Retell requests derive it from the call ID and slot.
    idempotency_key: z.string().trim().min(8).max(200).optional(),
    patient_id: patientId,
    reason: z
      .string()
      .trim()
      .min(2)
      .max(300)
      .describe(
        "Short visit reason in the caller's words, e.g. annual physical.",
      ),
    ...slotTimes,
  })
  .strict()
  .superRefine((value, context) => validateWindow(value, context, 1));

export const listPatientAppointmentsSchema = z
  .object({ patient_id: patientId })
  .strict();

export const rescheduleAppointmentSchema = z
  .object({
    appointment_id: appointmentId,
    patient_id: patientId,
    ...slotTimes,
  })
  .strict()
  .superRefine((value, context) => validateWindow(value, context, 1));

export const cancelAppointmentSchema = z
  .object({ appointment_id: appointmentId, patient_id: patientId })
  .strict();

export type ListDoctorsInput = z.infer<typeof listDoctorsSchema>;
export type FindPatientInput = z.infer<typeof findPatientSchema>;
export type CheckAvailabilityInput = z.infer<typeof checkAvailabilitySchema>;
export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema> & {
  idempotency_key: string;
};
export type ListPatientAppointmentsInput = z.infer<
  typeof listPatientAppointmentsSchema
>;
export type RescheduleAppointmentInput = z.infer<
  typeof rescheduleAppointmentSchema
>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;

function validateWindow(
  value: { start_at: string; end_at: string },
  context: z.RefinementCtx,
  maximumDays: number,
): void {
  const start = new Date(value.start_at);
  const end = new Date(value.end_at);
  const maximumMilliseconds = maximumDays * 24 * 60 * 60 * 1_000;
  if (start >= end)
    context.addIssue({
      code: "custom",
      message: "start_at must be before end_at.",
    });
  if (end.getTime() - start.getTime() > maximumMilliseconds) {
    context.addIssue({
      code: "custom",
      message: `The requested window cannot exceed ${maximumDays} day(s).`,
    });
  }
}
