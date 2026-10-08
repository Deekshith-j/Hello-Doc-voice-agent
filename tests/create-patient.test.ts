import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppointmentToolService } from "@/application/appointment-tool-service";
import type { CallLogRepository, ToolCallRecord } from "@/application/call-log";
import { CalendarSync } from "@/application/calendar-sync";
import { createPatientSchema } from "@/application/tool-schemas";
import { PostgresClinicRepository } from "@/db/postgres-clinic-repository";
import { createAvailabilityService } from "@/domain/availability-service";
import { createToolRoute } from "@/server/tool-route";
import { signRetellPayload } from "@/integrations/retell/signature";

import { FakeCalendar } from "./support/fake-calendar";
import {
  startTestDatabase,
  type TestDatabase,
} from "./support/test-database";

let database: TestDatabase;
let repository: PostgresClinicRepository;
let service: AppointmentToolService;

beforeAll(async () => {
  database = await startTestDatabase();
  repository = new PostgresClinicRepository(database.sql);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  const calendar = new FakeCalendar(() => new Date("2027-01-11T12:00:00.000Z"));
  const calendarSync = new CalendarSync(repository, calendar);
  service = new AppointmentToolService({
    repository,
    calendarSync,
    clock: () => new Date("2027-01-11T12:00:00.000Z"),
    getSlots: createAvailabilityService(
      (doctorId, from, to) =>
        repository.loadAvailabilitySnapshot(doctorId, from, to),
      calendar,
    ),
  });
});

describe("create_patient", () => {
  it("creates a new patient and returns patient_id on success", async () => {
    const result = await service.createPatient({
      full_name: "Alice Walker",
      date_of_birth: "1992-04-15",
      phone: "+15555550123",
      idempotency_key: "test-call-1-alice",
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("patient_created");
    expect(result.data).toHaveProperty("patient_id");
    expect(typeof (result.data as { patient_id: string }).patient_id).toBe("string");

    const patientId = (result.data as { patient_id: string }).patient_id;
    const found = await repository.findPatientByPhone("+15555550123");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(patientId);
    expect(found?.fullName).toBe("Alice Walker");

    const [dbRow] = await database.sql<{ phone_e164: string }[]>`
      SELECT phone_e164 FROM patients WHERE id = ${patientId}
    `;
    expect(dbRow?.phone_e164).toBe("+15555550123");
  });

  it("returns a neutral error message when duplicate name and DOB are submitted", async () => {
    // Create first patient
    await service.createPatient({
      full_name: "Bob Stone",
      date_of_birth: "1980-07-20",
      phone: "+15555550124",
      idempotency_key: "call-bob-1",
    });

    // Try to create another patient with the same name and DOB but different phone
    const duplicate = await service.createPatient({
      full_name: "Bob Stone",
      date_of_birth: "1980-07-20",
      phone: "+15555550125",
      idempotency_key: "call-bob-2",
    });

    expect(duplicate.ok).toBe(false);
    expect(duplicate.code).toBe("cannot_create_patient");
    expect(duplicate.message).toBe(
      "I can't create that record by phone, please call the front desk.",
    );
    // Ensure no existing patient details leaked
    expect(duplicate.data).toBeUndefined();
  });

  it("returns a neutral error message when phone number is already registered", async () => {
    // Create initial patient
    await service.createPatient({
      full_name: "Charlie Brown",
      date_of_birth: "1975-03-10",
      phone: "+15555550126",
      idempotency_key: "call-charlie-1",
    });

    // Attempt registration with same phone but different name and DOB
    const result = await service.createPatient({
      full_name: "Different Person",
      date_of_birth: "1990-11-12",
      phone: "+15555550126",
      idempotency_key: "call-different-1",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("cannot_create_patient");
    expect(result.message).toBe(
      "I can't create that record by phone, please call the front desk.",
    );
  });

  it("creates only one row when retried with the same call idempotency key", async () => {
    const input = {
      full_name: "Diana Prince",
      date_of_birth: "1985-09-28",
      phone: "+15555550127",
      idempotency_key: "call-diana-retry",
    };

    const firstResult = await service.createPatient(input);
    const secondResult = await service.createPatient(input);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);

    const firstId = (firstResult.data as { patient_id: string }).patient_id;
    const secondId = (secondResult.data as { patient_id: string }).patient_id;
    expect(firstId).toBe(secondId);

    const rows = await database.sql<{ count: string }[]>`
      SELECT count(*)::text as count FROM patients WHERE phone_e164 = '+15555550127'
    `;
    expect(rows[0]?.count).toBe("1");
  });

  it("rejects invalid or future date of birth during schema validation", () => {
    // Future date
    const futureResult = createPatientSchema.safeParse({
      full_name: "Future Baby",
      date_of_birth: "2099-01-01",
      phone: "+15555550128",
    });
    expect(futureResult.success).toBe(false);

    // Invalid calendar date
    const invalidDateResult = createPatientSchema.safeParse({
      full_name: "Invalid Day",
      date_of_birth: "1990-02-31",
      phone: "+15555550128",
    });
    expect(invalidDateResult.success).toBe(false);

    // Malformed format
    const malformedResult = createPatientSchema.safeParse({
      full_name: "Bad Format",
      date_of_birth: "04-15-1990",
      phone: "+15555550128",
    });
    expect(malformedResult.success).toBe(false);

    // Name too short (< 2 chars)
    const shortNameResult = createPatientSchema.safeParse({
      full_name: "A",
      date_of_birth: "1990-04-15",
      phone: "+15555550128",
    });
    expect(shortNameResult.success).toBe(false);
  });

  it("tells apart patients with the same name by date of birth in find_patient", async () => {
    // Seed two patients with identical name but different DOBs
    await database.sql`
      INSERT INTO patients (full_name, date_of_birth, phone_e164)
      VALUES
        ('Taylor Reed', '1985-03-15', '+15555550181'),
        ('Taylor Reed', '1998-11-22', '+15555550182')
    `;

    const find1 = await service.findPatient({
      full_name: "Taylor Reed",
      date_of_birth: "1985-03-15",
    });
    expect(find1.ok).toBe(true);
    expect(find1.code).toBe("patient_verified");

    const find2 = await service.findPatient({
      full_name: "Taylor Reed",
      date_of_birth: "1998-11-22",
    });
    expect(find2.ok).toBe(true);
    expect(find2.code).toBe("patient_verified");

    const id1 = (find1.data as { patient_id: string }).patient_id;
    const id2 = (find2.data as { patient_id: string }).patient_id;
    expect(id1).not.toBe(id2);
  });

  it("ensures no PHI (name, DOB, phone) appears in log output or persisted tool call records", async () => {
    const logSpy = vi.spyOn(console, "log");
    const recorded: ToolCallRecord[] = [];
    const testCallLog: CallLogRepository = {
      recordCallStarted: async () => {},
      recordCallEnded: async () => {},
      recordCallAnalyzed: async () => {},
      recordToolCall: async (record: ToolCallRecord) => {
        recorded.push(record);
      },
    };

    const route = createToolRoute(
      {
        name: "create_patient",
        schema: createPatientSchema,
        linksVerifiedPatient: true,
        execute: async (srv, input, meta) => {
          return srv.createPatient({
            ...input,
            idempotency_key: `${meta.callId}-${input.phone}`,
          });
        },
      },
      () => ({
        service,
        retellSigningKey: "signing-key-test",
        consumeRateLimit: async () => ({
          allowed: true,
          remaining: 10,
          retryAfterSeconds: 60,
        }),
        callLog: testCallLog,
      }),
    );

    const secretName = "SuperSecret PatientName";
    const secretDob = "1982-06-25";
    const secretPhone = "+15555550199";

    const body = {
      call: { call_id: "call_phi_test" },
      args: {
        full_name: secretName,
        date_of_birth: secretDob,
        phone: secretPhone,
      },
    };

    const raw = JSON.stringify(body);
    const signature = signRetellPayload(raw, "signing-key-test");
    process.env.RETELL_API_KEY = "signing-key-test";

    const request = new Request("http://localhost/api/tools/create-patient", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-retell-signature": signature,
        "x-request-id": "req-phi-1",
      },
      body: raw,
    });

    const response = await route(request);
    expect(response.status).toBe(200);

    // Verify console.log does NOT contain secretName, secretDob, or secretPhone
    const allLogText = logSpy.mock.calls
      .map((call) => call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
      .join("\n");

    expect(allLogText).not.toContain(secretName);
    expect(allLogText).not.toContain(secretDob);
    expect(allLogText).not.toContain(secretPhone);

    // Verify arguments persisted in tool calls are redacted
    expect(recorded.length).toBe(1);
    const recordedArgs = recorded[0]?.arguments as Record<string, unknown>;
    expect(recordedArgs?.full_name).toBe("[REDACTED]");
    expect(recordedArgs?.date_of_birth).toBe("[REDACTED]");
    expect(recordedArgs?.phone).toBe("[REDACTED]");

    logSpy.mockRestore();
  });
});
