// Defines the call scenarios the agent's tools must handle, each mirroring a real conversation path.
// Scenarios use seeded synthetic patients and look up live slots, so they never assume a date.
import { randomUUID } from "node:crypto";

import { seedDoctorIds } from "@/db/seed-data";

import { CaseRecorder } from "./checks";
import type { ToolClient, ToolReply } from "./tool-client";

export interface Scenario {
  name: string;
  run(client: ToolClient, check: CaseRecorder): Promise<void>;
}

const ALEX = { full_name: "Alex Morgan", date_of_birth: "1988-04-12" };
const PRIYA = { full_name: "Priya Natarajan", date_of_birth: "1975-11-30" };
const DANIEL = { full_name: "Daniel Okafor", date_of_birth: "1962-02-17" };
const GRACE = { full_name: "Grace Liu", date_of_birth: "1994-07-08" };

interface Slot {
  doctor_id: string;
  end_at: string;
  start_at: string;
}

export const scenarios: readonly Scenario[] = [
  {
    name: "Books a verified caller into an offered slot",
    async run(client, check) {
      const call = newCall();
      const doctors = await client.call(
        "list_doctors",
        { specialty: "Family Medicine" },
        call,
      );
      check.expectCode("list_doctors", doctors, "doctors_found");
      const patientId = await verify(client, check, ALEX, call);
      const slot = await firstSlot(
        client,
        check,
        { specialty: "Family Medicine" },
        call,
      );
      const booked = await client.call(
        "book_appointment",
        bookingArgs(patientId, slot),
        call,
      );
      check.expectCode("book_appointment", booked, "appointment_booked");
      const listed = await client.call(
        "list_patient_appointments",
        { patient_id: patientId },
        call,
      );
      check.expectCode(
        "list_patient_appointments",
        listed,
        "appointments_found",
      );
      const listedIds = itemsOf(listed, "appointments").map(
        (item) => (item as { appointment_id?: string }).appointment_id,
      );
      check.expect(
        "the new appointment is listed",
        listedIds.includes(appointmentId(booked)),
        `listed ${listedIds.length} appointment(s)`,
      );
    },
  },
  {
    name: "Refuses a caller whose date of birth does not match",
    async run(client, check) {
      const reply = await client.call(
        "find_patient",
        { ...ALEX, date_of_birth: "1988-04-13" },
        newCall(),
      );
      check.expectCode("find_patient", reply, "patient_not_verified");
      check.expect(
        "the refusal does not confirm the record exists",
        !reply.body.message.includes("Alex"),
        `"${reply.body.message}"`,
      );
    },
  },
  {
    name: "Lets exactly one of two simultaneous callers take a slot",
    async run(client, check) {
      const [firstCall, secondCall] = [newCall(), newCall()];
      const first = await verify(client, check, PRIYA, firstCall);
      const second = await verify(client, check, DANIEL, secondCall);
      const slot = await firstSlot(
        client,
        check,
        { doctor_id: seedDoctorIds.cardiology },
        firstCall,
      );
      const replies = await Promise.all([
        client.call("book_appointment", bookingArgs(first, slot), firstCall),
        client.call("book_appointment", bookingArgs(second, slot), secondCall),
      ]);
      const codes = replies.map((reply) => reply.body.code).sort();
      check.expect(
        "one booking wins and one is turned away",
        codes[0] === "appointment_booked" && codes[1] === "slot_unavailable",
        `got ${codes.join(", ")}`,
      );
      const loser = replies.find(
        (reply) => reply.body.code === "slot_unavailable",
      );
      check.expect(
        "the turned-away caller is offered alternatives",
        itemsOf(loser, "alternatives").length > 0,
        `${itemsOf(loser, "alternatives").length} alternative(s)`,
      );
      if (loser) check.expectSpeakable("slot_unavailable", loser);
    },
  },
  {
    name: "Returns the same appointment when Retell retries a booking",
    async run(client, check) {
      const call = newCall();
      const patientId = await verify(client, check, GRACE, call);
      const slot = await firstSlot(
        client,
        check,
        { doctor_id: seedDoctorIds.dermatology },
        call,
      );
      const first = await client.call(
        "book_appointment",
        bookingArgs(patientId, slot),
        call,
      );
      const retry = await client.call(
        "book_appointment",
        bookingArgs(patientId, slot),
        call,
      );
      check.expectCode("first attempt", first, "appointment_booked");
      check.expectCode("retry", retry, "appointment_booked");
      check.expect(
        "both attempts refer to one appointment",
        appointmentId(first) === appointmentId(retry),
        `${appointmentId(first)} vs ${appointmentId(retry)}`,
      );
    },
  },
  {
    name: "Reschedules an appointment and frees the original time",
    async run(client, check) {
      const call = newCall();
      const patientId = await verify(client, check, ALEX, call);
      const options = await slots(
        client,
        check,
        { doctor_id: seedDoctorIds.pediatrics },
        call,
      );
      const [original, replacement] = options;
      if (!original || !replacement) {
        check.expect("two open slots exist", false, `found ${options.length}`);
        return;
      }
      const booked = await client.call(
        "book_appointment",
        bookingArgs(patientId, original),
        call,
      );
      const moved = await client.call(
        "reschedule_appointment",
        {
          appointment_id: appointmentId(booked),
          patient_id: patientId,
          start_at: replacement.start_at,
          end_at: replacement.end_at,
        },
        call,
      );
      check.expectCode(
        "reschedule_appointment",
        moved,
        "appointment_rescheduled",
      );
      const reopened = await slots(
        client,
        check,
        { doctor_id: seedDoctorIds.pediatrics },
        call,
      );
      check.expect(
        "the original time is offered again",
        reopened.some((slot) => slot.start_at === original.start_at),
        `original ${original.start_at}`,
      );
    },
  },
  {
    name: "Cancels an appointment, and a repeated cancel is harmless",
    async run(client, check) {
      const call = newCall();
      const patientId = await verify(client, check, PRIYA, call);
      const slot = await firstSlot(
        client,
        check,
        { doctor_id: seedDoctorIds.familyMedicine },
        call,
      );
      const booked = await client.call(
        "book_appointment",
        bookingArgs(patientId, slot),
        call,
      );
      const request = {
        appointment_id: appointmentId(booked),
        patient_id: patientId,
      };
      check.expectCode(
        "cancel",
        await client.call("cancel_appointment", request, call),
        "appointment_cancelled",
      );
      check.expectCode(
        "repeat cancel",
        await client.call("cancel_appointment", request, call),
        "appointment_cancelled",
      );
    },
  },
  {
    name: "Refuses to change another patient's appointment",
    async run(client, check) {
      const ownerCall = newCall();
      const owner = await verify(client, check, DANIEL, ownerCall);
      const slot = await firstSlot(
        client,
        check,
        { doctor_id: seedDoctorIds.familyMedicine },
        ownerCall,
      );
      const booked = await client.call(
        "book_appointment",
        bookingArgs(owner, slot),
        ownerCall,
      );
      const intruderCall = newCall();
      const intruder = await verify(client, check, GRACE, intruderCall);
      const reply = await client.call(
        "cancel_appointment",
        { appointment_id: appointmentId(booked), patient_id: intruder },
        intruderCall,
      );
      check.expectCode(
        "cancel by another patient",
        reply,
        "appointment_not_found",
      );
    },
  },
  {
    name: "Turns away a time outside clinic hours",
    async run(client, check) {
      const call = newCall();
      const patientId = await verify(client, check, ALEX, call);
      const start = nextWeekdayAtUtc(8); // 03:00–04:00 in every seeded doctor's timezone.
      const reply = await client.call(
        "book_appointment",
        bookingArgs(patientId, {
          doctor_id: seedDoctorIds.familyMedicine,
          start_at: start.toISOString(),
          end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        }),
        call,
      );
      check.expectCode("book_appointment at 3 AM", reply, "slot_unavailable");
    },
  },
  {
    name: "Explains invalid arguments so the agent can correct itself",
    async run(client, check) {
      const now = new Date();
      const reply = await client.call(
        "check_availability",
        {
          doctor_id: seedDoctorIds.cardiology,
          specialty: "Cardiology",
          start_at: now.toISOString(),
          end_at: new Date(now.getTime() + 86_400_000).toISOString(),
        },
        newCall(),
      );
      check.expectCode(
        "ambiguous availability search",
        reply,
        "invalid_request",
      );
      check.expect(
        "the reply lists what was wrong",
        itemsOf(reply, "issues").length > 0,
        JSON.stringify((reply.body.data as { issues?: unknown })?.issues ?? []),
      );
    },
  },
  {
    name: "Rejects requests that are not signed by Retell",
    async run(client, check) {
      const reply = await client.call("find_patient", ALEX, newCall(), {
        sign: false,
      });
      check.expect(
        "unsigned request is refused",
        reply.status === 401,
        `HTTP ${reply.status}`,
      );
    },
  },
];

function newCall(): string {
  return `eval_${randomUUID()}`;
}

async function verify(
  client: ToolClient,
  check: CaseRecorder,
  patient: { date_of_birth: string; full_name: string },
  call: string,
): Promise<string> {
  const reply = await client.call("find_patient", patient, call);
  check.expectCode(
    `find_patient (${patient.full_name})`,
    reply,
    "patient_verified",
  );
  return String(
    (reply.body.data as { patient_id?: string } | undefined)?.patient_id ?? "",
  );
}

async function slots(
  client: ToolClient,
  check: CaseRecorder,
  target: { doctor_id?: string; specialty?: string },
  call: string,
): Promise<Slot[]> {
  const now = new Date();
  const reply = await client.call(
    "check_availability",
    {
      ...target,
      start_at: now.toISOString(),
      end_at: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    },
    call,
  );
  check.expectCode("check_availability", reply, "availability_found");
  return (reply.body.data as { slots?: Slot[] } | undefined)?.slots ?? [];
}

async function firstSlot(
  client: ToolClient,
  check: CaseRecorder,
  target: { doctor_id?: string; specialty?: string },
  call: string,
): Promise<Slot> {
  const [slot] = await slots(client, check, target, call);
  if (!slot) throw new Error("No open slot was available for this scenario.");
  return slot;
}

function bookingArgs(patientId: string, slot: Slot) {
  return {
    patient_id: patientId,
    doctor_id: slot.doctor_id,
    start_at: slot.start_at,
    end_at: slot.end_at,
    reason: "Evaluation visit",
  };
}

function appointmentId(reply: ToolReply): string {
  return String(
    (reply.body.data as { appointment_id?: string } | undefined)
      ?.appointment_id ?? "",
  );
}

function itemsOf(reply: ToolReply | undefined, key: string): unknown[] {
  const value = (reply?.body.data as Record<string, unknown> | undefined)?.[
    key
  ];
  return Array.isArray(value) ? value : [];
}

function nextWeekdayAtUtc(hour: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
    date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}
