// Contains deterministic, synthetic clinic records used by local development and demos.
// Fixed identifiers make later API examples and eval fixtures repeatable across resets.
import { z } from "zod";

const doctorSchema = z.object({
  id: z.uuid(),
  fullName: z.string().min(1),
  specialty: z.string().min(1),
  timezone: z.string().refine(isIanaTimeZone, "Expected an IANA timezone"),
});

const ruleSchema = z.object({
  doctorId: z.uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  slotDurationMinutes: z.number().int().min(5).max(240),
});

export const seedDoctorIds = {
  familyMedicine: "10000000-0000-4000-8000-000000000001",
  cardiology: "10000000-0000-4000-8000-000000000002",
  dermatology: "10000000-0000-4000-8000-000000000003",
  pediatrics: "10000000-0000-4000-8000-000000000004",
} as const;

export const seedDoctors = doctorSchema.array().parse([
  {
    id: seedDoctorIds.familyMedicine,
    fullName: "Dr. Maya Chen",
    specialty: "Family Medicine",
    timezone: "America/New_York",
  },
  {
    id: seedDoctorIds.cardiology,
    fullName: "Dr. Rafael Ortiz",
    specialty: "Cardiology",
    timezone: "America/Chicago",
  },
  {
    id: seedDoctorIds.dermatology,
    fullName: "Dr. Priya Shah",
    specialty: "Dermatology",
    timezone: "America/Denver",
  },
  {
    id: seedDoctorIds.pediatrics,
    fullName: "Dr. Jordan Brooks",
    specialty: "Pediatrics",
    timezone: "America/Los_Angeles",
  },
]);

const patientSchema = z.object({
  fullName: z.string().min(1),
  dateOfBirth: z.iso.date(),
  phoneE164: z.string().regex(/^\+1555555\d{4}$/, "Use reserved 555 numbers"),
});

// Every number is in the reserved 555-555-01xx fiction range, so no real person can be dialled.
export const seedPatients = patientSchema.array().parse([
  {
    fullName: "Alex Morgan",
    dateOfBirth: "1988-04-12",
    phoneE164: "+15555550101",
  },
  {
    fullName: "Sam Rivera",
    dateOfBirth: "2017-09-03",
    phoneE164: "+15555550102",
  },
  {
    fullName: "Priya Natarajan",
    dateOfBirth: "1975-11-30",
    phoneE164: "+15555550103",
  },
  {
    fullName: "Daniel Okafor",
    dateOfBirth: "1962-02-17",
    phoneE164: "+15555550104",
  },
  {
    fullName: "Grace Liu",
    dateOfBirth: "1994-07-08",
    phoneE164: "+15555550105",
  },
  {
    fullName: "Mateo Alvarez",
    dateOfBirth: "2012-05-21",
    phoneE164: "+15555550106",
  },
  {
    fullName: "Hannah Becker",
    dateOfBirth: "1983-09-14",
    phoneE164: "+15555550107",
  },
  {
    fullName: "Omar Haddad",
    dateOfBirth: "1970-12-02",
    phoneE164: "+15555550108",
  },
]);

export const seedRules = ruleSchema.array().parse([
  ...weekdayRules(seedDoctorIds.familyMedicine, "08:30", "17:00", 30),
  ...weekdayRules(seedDoctorIds.cardiology, "09:00", "16:00", 30, [1, 2, 4, 5]),
  ...weekdayRules(
    seedDoctorIds.dermatology,
    "10:00",
    "18:00",
    30,
    [1, 2, 3, 4],
  ),
  ...weekdayRules(seedDoctorIds.pediatrics, "08:00", "16:30", 30),
  {
    doctorId: seedDoctorIds.pediatrics,
    dayOfWeek: 6,
    startTime: "09:00",
    endTime: "13:00",
    slotDurationMinutes: 30,
  },
]);

function weekdayRules(
  doctorId: string,
  startTime: string,
  endTime: string,
  slotDurationMinutes: number,
  days: readonly number[] = [1, 2, 3, 4, 5],
) {
  return days.map((dayOfWeek) => ({
    doctorId,
    dayOfWeek,
    startTime,
    endTime,
    slotDurationMinutes,
  }));
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
