// Verifies call recording against real SQL: out-of-order events, outcomes, and dashboard reads.
// Webhooks retry and tool requests can precede call_started, so every path must converge.
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { toolFailure, toolSuccess } from "@/application/tool-response";
import { PostgresCallLogRepository } from "@/db/postgres-call-log-repository";
import { PostgresDashboardRepository } from "@/db/postgres-dashboard-repository";

import {
  PATIENT_ID,
  startTestDatabase,
  type TestDatabase,
} from "./support/test-database";

let database: TestDatabase;
let callLog: PostgresCallLogRepository;
let dashboard: PostgresDashboardRepository;
const STARTED = new Date("2027-01-11T15:00:00.000Z");

beforeAll(async () => {
  database = await startTestDatabase();
  callLog = new PostgresCallLogRepository(database.sql);
  dashboard = new PostgresDashboardRepository(database.sql);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

it("links a tool call that arrives before call_started, then fills in the call", async () => {
  await callLog.recordToolCall(
    tool("find_patient", "10000000-0000-4000-8000-0000000000a1", PATIENT_ID),
  );
  await callLog.recordCallStarted({
    providerCallId: "call_1",
    agentId: "agent_1",
    callType: "web_call",
    startedAt: STARTED,
  });

  const [call] = await dashboard.listCalls(10);
  expect(call).toMatchObject({
    providerCallId: "call_1",
    patientName: "Alex Morgan",
    callType: "web_call",
    toolCount: 1,
    outcome: "in_progress",
  });
});

it("derives the outcome from the last successful write tool", async () => {
  await callLog.recordToolCall(
    tool("book_appointment", "10000000-0000-4000-8000-0000000000b1"),
  );
  await callLog.recordToolCall({
    ...tool("cancel_appointment", "10000000-0000-4000-8000-0000000000b2"),
    result: toolFailure("appointment_not_found", "Not found."),
  });
  await callLog.recordCallEnded(ended("user_hangup"));

  const [call] = await dashboard.listCalls(10);
  expect(call).toMatchObject({ outcome: "booked", failedTools: 1 });
});

it("marks errored calls without a write as failed and surfaces them for attention", async () => {
  await callLog.recordCallEnded(ended("error_llm_websocket_open"));
  const [call] = await dashboard.listCalls(10);
  expect(call?.outcome).toBe("failed");
  const [item] = await dashboard.listAttentionItems(5);
  expect(item).toMatchObject({
    kind: "failed_call",
    href: `/calls/${call?.id}`,
  });
});

it("ignores a retried tool delivery with the same request ID", async () => {
  const record = tool("find_patient", "10000000-0000-4000-8000-0000000000c1");
  await callLog.recordToolCall(record);
  await callLog.recordToolCall(record);
  const [call] = await dashboard.listCalls(10);
  expect(call?.toolCount).toBe(1);
});

it("stores the transcript and analysis for the call detail view", async () => {
  await callLog.recordCallEnded(ended("agent_hangup"));
  await callLog.recordCallAnalyzed({
    providerCallId: "call_1",
    summary: "Booked a physical.",
  });
  const [summary] = await dashboard.listCalls(10);
  const detail = await dashboard.getCall(summary?.id ?? "");
  expect(detail).toMatchObject({
    summary: "Booked a physical.",
    disconnectionReason: "agent_hangup",
    transcript: [{ speaker: "agent", text: "Hello.", offsetSeconds: 0.5 }],
  });
});

function tool(
  toolName: string,
  requestId: string,
  verifiedPatientId: string | null = null,
) {
  return {
    providerCallId: "call_1",
    requestId,
    toolName,
    arguments: {},
    result: toolSuccess("ok", "Done.", {}),
    latencyMs: 120,
    verifiedPatientId,
  };
}

function ended(disconnectionReason: string) {
  return {
    providerCallId: "call_1",
    agentId: "agent_1",
    callType: "web_call",
    startedAt: STARTED,
    endedAt: new Date(STARTED.getTime() + 90_000),
    disconnectionReason,
    e2eLatencyP50Ms: 820,
    transcript: [
      { speaker: "agent" as const, text: "Hello.", offsetSeconds: 0.5 },
    ],
  };
}
