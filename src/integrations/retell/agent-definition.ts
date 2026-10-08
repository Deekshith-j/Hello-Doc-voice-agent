// Defines the Retell agent: its prompt, voice settings, and custom-function tools.
// Tool parameters are generated from the server's Zod schemas, so both sides share one contract.
import { z } from "zod";

import {
  bookAppointmentSchema,
  cancelAppointmentSchema,
  checkAvailabilitySchema,
  findPatientSchema,
  listDoctorsSchema,
  listPatientAppointmentsSchema,
  rescheduleAppointmentSchema,
} from "@/application/tool-schemas";

// Short enough to keep the line responsive, long enough for a cold database connection.
const TOOL_TIMEOUT_MS = 10_000;

export interface AgentSettings {
  clinicName: string;
  clinicTimeZone: string;
  model: string;
  publicBaseUrl: string;
  voiceId: string;
}

interface ToolSpec {
  description: string;
  executionMessage?: string;
  name: string;
  path: string;
  schema: z.ZodType;
}

const tools: readonly ToolSpec[] = [
  {
    name: "list_doctors",
    path: "list-doctors",
    schema: listDoctorsSchema,
    description:
      "List the clinic's doctors with their doctor_id and specialty. Use it to resolve a doctor the caller names.",
  },
  {
    name: "find_patient",
    path: "find-patient",
    schema: findPatientSchema,
    executionMessage: "Let me pull up your record.",
    description:
      "Verify the caller using full name and date of birth. Required before any appointment action.",
  },
  {
    name: "check_availability",
    path: "check-availability",
    schema: checkAvailabilitySchema,
    executionMessage: "Let me check the schedule.",
    description:
      "Find open appointment slots for one doctor or a whole specialty within a window of up to 14 days.",
  },
  {
    name: "book_appointment",
    path: "book-appointment",
    schema: bookAppointmentSchema,
    executionMessage: "Booking that now.",
    description:
      "Book a slot returned by check_availability after the caller has explicitly confirmed it.",
  },
  {
    name: "list_patient_appointments",
    path: "list-patient-appointments",
    schema: listPatientAppointmentsSchema,
    executionMessage: "Let me look up your appointments.",
    description:
      "List the verified patient's upcoming appointments. Use it before rescheduling or cancelling.",
  },
  {
    name: "reschedule_appointment",
    path: "reschedule-appointment",
    schema: rescheduleAppointmentSchema,
    executionMessage: "Moving that for you.",
    description:
      "Move an upcoming appointment to a new slot from check_availability, after the caller confirms.",
  },
  {
    name: "cancel_appointment",
    path: "cancel-appointment",
    schema: cancelAppointmentSchema,
    executionMessage: "Cancelling that now.",
    description:
      "Cancel an upcoming appointment after the caller has explicitly confirmed which one.",
  },
];

export function buildRetellLlm(settings: AgentSettings) {
  return {
    model: settings.model,
    start_speaker: "agent",
    begin_message: `Thanks for calling ${settings.clinicName}. This is the scheduling assistant. How can I help you today?`,
    general_prompt: buildPrompt(settings),
    general_tools: [
      {
        type: "end_call",
        name: "end_call",
        description:
          "End the call after the caller says goodbye or confirms they need nothing else.",
      },
      ...tools.map((tool) => toCustomTool(tool, settings.publicBaseUrl)),
    ],
  };
}

export function buildRetellAgent(settings: AgentSettings, llmId: string) {
  return {
    agent_name: `${settings.clinicName} scheduling`,
    response_engine: { type: "retell-llm", llm_id: llmId },
    voice_id: settings.voiceId,
    language: "en-US",
    webhook_url: `${settings.publicBaseUrl}/api/retell/webhook`,
    webhook_events: ["call_started", "call_ended", "call_analyzed"],
    // Patients pause to find dates; a slightly patient turn-taker avoids talking over them.
    responsiveness: 0.9,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    end_call_after_silence_ms: 30_000,
    max_call_duration_ms: 15 * 60 * 1_000,
  };
}

export function toolNames(): string[] {
  return tools.map((tool) => tool.name);
}

function toCustomTool(tool: ToolSpec, publicBaseUrl: string) {
  return {
    type: "custom",
    name: tool.name,
    description: tool.description,
    url: `${publicBaseUrl}/api/tools/${tool.path}`,
    method: "POST",
    parameters: toParameters(tool.schema),
    speak_during_execution: Boolean(tool.executionMessage),
    ...(tool.executionMessage
      ? { execution_message_description: tool.executionMessage }
      : {}),
    speak_after_execution: true,
    timeout_ms: TOOL_TIMEOUT_MS,
  };
}

function toParameters(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  // The server derives idempotency from the call, so the model never invents keys.
  const properties = { ...json.properties };
  delete properties.idempotency_key;
  return {
    type: "object",
    properties,
    required: (json.required ?? []).filter((key) => key !== "idempotency_key"),
  };
}

function buildPrompt(settings: AgentSettings): string {
  const now = `{{current_time_${settings.clinicTimeZone}}}`;
  const calendar = `{{current_calendar_${settings.clinicTimeZone}}}`;
  return `You are the scheduling assistant for ${settings.clinicName}. You help callers book, reschedule, and cancel doctor appointments by phone.

## Context
- Current time: ${now}
- Calendar for the next two weeks:
${calendar}
- When you send times to tools, use ISO 8601 with the correct offset for the doctor's timezone.

## How to run the call
1. Ask what the caller needs.
2. Before any appointment action, verify identity: ask for full name and date of birth, then call find_patient. If verification fails, ask them to repeat both once. If it fails again, say you can't access the record by phone and suggest calling the front desk during office hours. Never reveal whether a record exists.
3. Booking: learn the reason and any doctor or specialty preference. Call list_doctors if they name a doctor. Call check_availability for a window that matches what they asked for (default: the next 7 days). Offer at most three options using each slot's "when" text. After they choose, repeat the doctor, day, and time and ask for a clear yes. Only then call book_appointment with that slot's doctor_id, start_at, and end_at copied exactly.
4. Rescheduling or cancelling: call list_patient_appointments, confirm which appointment, then for a reschedule find a new slot as in step 3. Get a clear yes before calling reschedule_appointment or cancel_appointment.
5. After any change, read back the result in one sentence and ask if there is anything else.

## Rules
- Tool results include a "message". It is accurate and safe to say; base your reply on it. Never claim something happened unless a tool result says so.
- If a result code ends in "_calendar_pending", the appointment is confirmed; mention that the doctor's calendar will update shortly.
- If a slot is unavailable, offer the alternatives in the result instead of retrying the same time.
- If a tool says live availability can't be confirmed, apologize briefly and suggest calling back in a few minutes. Do not guess times.
- Never give medical advice. If the caller describes an emergency such as chest pain, trouble breathing, or severe bleeding, tell them to hang up and call 911 now.
- Only discuss the verified caller's own appointments. Never read out other patients' details, IDs, or internal codes.
- Speak naturally and briefly: one question at a time, no lists, no reading out IDs or ISO timestamps.
- When the caller is finished, say goodbye and call end_call.`;
}
