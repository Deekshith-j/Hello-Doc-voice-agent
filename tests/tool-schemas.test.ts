// Verifies the cross-field rules that keep ambiguous or oversized tool requests out of the service.
// Each case names the invariant it protects so schema changes fail with a clear reason.
import { describe, expect, it } from "vitest";

import {
  bookAppointmentSchema,
  checkAvailabilitySchema,
} from "@/application/tool-schemas";

const DOCTOR_ID = "10000000-0000-4000-8000-000000000001";
const window = {
  start_at: "2027-01-12T14:00:00Z",
  end_at: "2027-01-12T14:30:00Z",
};

describe("check_availability schema", () => {
  it("accepts exactly one of doctor or specialty", () => {
    expect(
      checkAvailabilitySchema.safeParse({ ...window, doctor_id: DOCTOR_ID })
        .success,
    ).toBe(true);
    expect(checkAvailabilitySchema.safeParse(window).success).toBe(false);
    expect(
      checkAvailabilitySchema.safeParse({
        ...window,
        doctor_id: DOCTOR_ID,
        specialty: "Cardiology",
      }).success,
    ).toBe(false);
  });

  it("rejects reversed and oversized windows", () => {
    expect(
      checkAvailabilitySchema.safeParse({
        doctor_id: DOCTOR_ID,
        start_at: window.end_at,
        end_at: window.start_at,
      }).success,
    ).toBe(false);
    expect(
      checkAvailabilitySchema.safeParse({
        doctor_id: DOCTOR_ID,
        start_at: "2027-01-01T00:00:00Z",
        end_at: "2027-01-16T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("requires timestamps with an explicit offset", () => {
    expect(
      checkAvailabilitySchema.safeParse({
        doctor_id: DOCTOR_ID,
        start_at: "2027-01-12T14:00:00",
        end_at: "2027-01-12T15:00:00",
      }).success,
    ).toBe(false);
  });
});

describe("book_appointment schema", () => {
  it("rejects fields the tool contract does not define", () => {
    const result = bookAppointmentSchema.safeParse({
      ...window,
      doctor_id: DOCTOR_ID,
      patient_id: DOCTOR_ID,
      reason: "Checkup",
      idempotency_key: "call-123-book",
      calendar_id: "someone-else@example.com",
    });
    expect(result.success).toBe(false);
  });
});
