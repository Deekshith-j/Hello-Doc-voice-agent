import { AppointmentToolService } from "@/application/appointment-tool-service";
import { CalendarSync } from "@/application/calendar-sync";
import {
  bookAppointmentSchema,
  cancelAppointmentSchema,
  checkAvailabilitySchema,
  createPatientSchema,
  findPatientSchema,
  listDoctorsSchema,
  listPatientAppointmentsSchema,
  rescheduleAppointmentSchema,
} from "@/application/tool-schemas";
import { PostgresClinicRepository } from "@/db/postgres-clinic-repository";
import { createAvailabilityService } from "@/domain/availability-service";
import { buildPrompt } from "@/integrations/retell/agent-definition";

import { FakeCalendar } from "../../tests/support/fake-calendar";
import type { TestDatabase } from "../../tests/support/test-database";
import type { ChatCompletionTool, ChatMessage } from "./llm-client";
import { getLlmClient } from "./llm-client";
import type { ToolCallRecord } from "./types";

function toOpenAiTool(
  name: string,
  description: string,
  schema: import("zod").ZodType,
): ChatCompletionTool {
  const json = import("zod").z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = { ...json.properties };
  delete properties.idempotency_key;
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required: (json.required ?? []).filter((k) => k !== "idempotency_key"),
      },
    },
  };
}

export const AGENT_TOOLS: ChatCompletionTool[] = [
  toOpenAiTool(
    "list_doctors",
    "List the clinic's doctors with their doctor_id and specialty.",
    listDoctorsSchema,
  ),
  toOpenAiTool(
    "find_patient",
    "Verify the caller using full name and date of birth. Required before any appointment action.",
    findPatientSchema,
  ),
  toOpenAiTool(
    "create_patient",
    "Register a new patient with their full name, date of birth (YYYY-MM-DD), and phone number.",
    createPatientSchema,
  ),
  toOpenAiTool(
    "check_availability",
    "Find open appointment slots for one doctor or a whole specialty within a window of up to 14 days.",
    checkAvailabilitySchema,
  ),
  toOpenAiTool(
    "book_appointment",
    "Book a slot returned by check_availability after caller confirmation.",
    bookAppointmentSchema,
  ),
  toOpenAiTool(
    "list_patient_appointments",
    "List the verified patient's upcoming appointments before rescheduling or cancelling.",
    listPatientAppointmentsSchema,
  ),
  toOpenAiTool(
    "reschedule_appointment",
    "Move an upcoming appointment to a new slot after confirmation.",
    rescheduleAppointmentSchema,
  ),
  toOpenAiTool(
    "cancel_appointment",
    "Cancel an upcoming appointment after caller confirmation.",
    cancelAppointmentSchema,
  ),
  {
    type: "function",
    function: {
      name: "end_call",
      description: "End the call after the caller says goodbye or confirms they need nothing else.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

export class AgentHarness {
  private service: AppointmentToolService;
  private calendar: FakeCalendar;

  constructor(
    private database: TestDatabase,
    private clock: () => Date = () => new Date("2026-10-12T12:00:00.000Z"),
  ) {
    const repository = new PostgresClinicRepository(this.database.sql);
    this.calendar = new FakeCalendar(this.clock);
    const calendarSync = new CalendarSync(repository, this.calendar);
    this.service = new AppointmentToolService({
      repository,
      calendarSync,
      clock: this.clock,
      getSlots: createAvailabilityService(
        (doctorId, from, to) =>
          repository.loadAvailabilitySnapshot(doctorId, from, to),
        this.calendar,
      ),
    });
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const derivedKey = `eval-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    switch (name) {
      case "list_doctors":
        return this.service.listDoctors(args);
      case "find_patient":
        return this.service.findPatient(
          args as unknown as Parameters<typeof this.service.findPatient>[0],
        );
      case "create_patient":
        return this.service.createPatient({
          ...args,
          idempotency_key: derivedKey,
        } as unknown as Parameters<typeof this.service.createPatient>[0]);
      case "check_availability":
        return this.service.checkAvailability(
          args as unknown as Parameters<typeof this.service.checkAvailability>[0],
        );
      case "book_appointment":
        return this.service.bookAppointment({
          ...args,
          idempotency_key: derivedKey,
        } as unknown as Parameters<typeof this.service.bookAppointment>[0]);
      case "list_patient_appointments":
        return this.service.listPatientAppointments(
          args as unknown as Parameters<typeof this.service.listPatientAppointments>[0],
        );
      case "reschedule_appointment":
        return this.service.rescheduleAppointment({
          ...args,
          idempotency_key: derivedKey,
        } as unknown as Parameters<typeof this.service.rescheduleAppointment>[0]);
      case "cancel_appointment":
        return this.service.cancelAppointment(
          args as unknown as Parameters<typeof this.service.cancelAppointment>[0],
        );
      case "end_call":
        return { ok: true, code: "call_ended", message: "Call ended." };
      default:
        return { ok: false, code: "unknown_tool", message: `Tool ${name} not found.` };
    }
  }

  async runAgentTurn(params: {
    model: string;
    messages: ChatMessage[];
    onToolCall?: (record: ToolCallRecord) => void;
  }): Promise<{ reply: string; toolCalls: ToolCallRecord[]; endedCall: boolean }> {
    const client = getLlmClient();
    const systemPrompt = buildPrompt()
      .replaceAll("{{clinic_name}}", "Downtown Health Clinic")
      .replaceAll("{{emergency_number}}", "911")
      .replaceAll(
        "{{current_time}}",
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          dateStyle: "full",
          timeStyle: "short",
        }).format(this.clock()),
      );

    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...params.messages,
    ];

    const records: ToolCallRecord[] = [];
    let endedCall = false;

    // Run agent loop until final textual response is generated (or call ends)
    for (let step = 0; step < 5; step++) {
      const completion = await client.chatCompletion({
        model: params.model,
        messages: fullMessages,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
      });

      const message = completion.message;
      fullMessages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        return {
          reply: message.content?.trim() || "",
          toolCalls: records,
          endedCall,
        };
      }

      for (const tc of message.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedArgs = {};
        }

        if (tc.function.name === "end_call") {
          endedCall = true;
        }

        const result = await this.executeTool(tc.function.name, parsedArgs);
        const record: ToolCallRecord = {
          tool_name: tc.function.name,
          arguments: parsedArgs,
          result,
          timestamp: Date.now(),
        };
        records.push(record);
        params.onToolCall?.(record);

        fullMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result),
        });
      }
    }

    const last = fullMessages[fullMessages.length - 1];
    return {
      reply: last?.content || "",
      toolCalls: records,
      endedCall,
    };
  }
}
