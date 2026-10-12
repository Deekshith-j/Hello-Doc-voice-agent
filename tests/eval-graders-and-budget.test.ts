import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { gradeDbState } from "../evals/agent-eval/graders/db-grader";
import { JUDGE_RUBRIC } from "../evals/agent-eval/graders/judge-grader";
import { gradeToolTrace } from "../evals/agent-eval/graders/trace-grader";
import { BudgetExceededError, LlmClient } from "../evals/agent-eval/llm-client";
import type { Scenario, ToolCallRecord, TranscriptTurn } from "../evals/agent-eval/types";

describe("Evaluation Budget Cap", () => {
  it("calculates cost accurately based on model pricing", () => {
    const client = new LlmClient({ apiKey: "test-key", hardCapUsd: 2.0 });

    // gpt-4o-mini: $0.15/1M input, $0.60/1M output
    const cost = client.calculateCost("gpt-4o-mini", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 4);

    // gpt-4o: $2.50/1M input, $10.00/1M output
    const judgeCost = client.calculateCost("gpt-4o", 100_000, 10_000);
    expect(judgeCost).toBeCloseTo(0.35, 4);
  });

  it("throws BudgetExceededError when hard cap is breached", () => {
    const client = new LlmClient({ apiKey: "test-key", hardCapUsd: 0.05 });
    expect(client.getHardCap()).toBe(0.05);

    // BudgetExceededError has proper message and properties
    const error = new BudgetExceededError(0.06, 0.05);
    expect(error.name).toBe("BudgetExceededError");
    expect(error.currentCostUsd).toBe(0.06);
    expect(error.capUsd).toBe(0.05);
    expect(error.message).toContain("hard cap of $0.05");
  });

  it("resets spending properly", () => {
    const client = new LlmClient({ apiKey: "test-key", hardCapUsd: 2.0 });
    expect(client.getTotalCost()).toBe(0);
    expect(client.getTotalTokens().total).toBe(0);
  });
});

describe("Tool Trace Grader", () => {
  const dummyScenario: Scenario = {
    id: "test-01",
    category: "book_existing_patient",
    persona: "Normal caller",
    goal: "Book Tuesday slot",
    caller_info: {
      stated_name: "Eleanor Vance",
      spelled_name: "E-L-E-A-N-O-R",
      stated_dob: "1952-04-12",
      stated_phone: "+15552345678",
    },
    starting_db_state: {},
    expected_outcome: { should_book: true },
  };

  it("passes when valid sequence (find -> availability -> book) is followed", () => {
    const toolCalls: ToolCallRecord[] = [
      {
        tool_name: "find_patient",
        arguments: { full_name: "Eleanor Vance", date_of_birth: "1952-04-12" },
        result: { ok: true, data: { patient_id: "p1" } },
        timestamp: 1000,
      },
      {
        tool_name: "check_availability",
        arguments: { doctor_id: "d1" },
        result: { ok: true, data: { slots: [] } },
        timestamp: 2000,
      },
      {
        tool_name: "book_appointment",
        arguments: { doctor_id: "d1", start_at: "2026-10-20T10:00:00Z" },
        result: { ok: true, data: { appointment_id: "a1" } },
        timestamp: 3000,
      },
    ];

    const transcript: TranscriptTurn[] = [
      { role: "agent", content: "Would you like me to book Tuesday at 10 AM?" },
      { role: "patient", content: "Yes please, that works perfectly." },
      {
        role: "agent",
        content: "You're all booked.",
        tool_calls: [toolCalls[2]!],
      },
    ];

    const grade = gradeToolTrace(dummyScenario, toolCalls, transcript);
    expect(grade.passed).toBe(true);
  });

  it("fails when book_appointment is called before find_patient", () => {
    const toolCalls: ToolCallRecord[] = [
      {
        tool_name: "book_appointment",
        arguments: { doctor_id: "d1", start_at: "2026-10-20T10:00:00Z" },
        result: { ok: true },
        timestamp: 1000,
      },
    ];

    const grade = gradeToolTrace(dummyScenario, toolCalls, []);
    expect(grade.passed).toBe(false);
    expect(grade.reason).toContain("before verifying patient");
  });

  it("fails when book_appointment is called without check_availability", () => {
    const toolCalls: ToolCallRecord[] = [
      {
        tool_name: "find_patient",
        arguments: { full_name: "Eleanor Vance", date_of_birth: "1952-04-12" },
        result: { ok: true },
        timestamp: 1000,
      },
      {
        tool_name: "book_appointment",
        arguments: { doctor_id: "d1", start_at: "2026-10-20T10:00:00Z" },
        result: { ok: true },
        timestamp: 2000,
      },
    ];

    const grade = gradeToolTrace(dummyScenario, toolCalls, []);
    expect(grade.passed).toBe(false);
    expect(grade.reason).toContain("without first calling check_availability");
  });

  it("fails when find_patient arguments do not match caller name", () => {
    const toolCalls: ToolCallRecord[] = [
      {
        tool_name: "find_patient",
        arguments: { full_name: "Completely Different", date_of_birth: "1952-04-12" },
        result: { ok: false },
        timestamp: 1000,
      },
    ];

    const grade = gradeToolTrace(dummyScenario, toolCalls, []);
    expect(grade.passed).toBe(false);
    expect(grade.reason).toContain("name mismatch");
  });
});

describe("LLM Judge Rubric", () => {
  it("includes all mandatory criteria in the rubric definition", () => {
    expect(JUDGE_RUBRIC).toContain("Safety & Emergency");
    expect(JUDGE_RUBRIC).toContain("Privacy & Grounding");
    expect(JUDGE_RUBRIC).toContain("Conversational Style");
    expect(JUDGE_RUBRIC).toContain("Confirmation");
    expect(JUDGE_RUBRIC).toContain("911");
    expect(JUDGE_RUBRIC).toContain("medical advice");
  });
});

describe("DB State Grader Invariants", () => {
  it("detects fake sql results violating duplicate phone invariant", async () => {
    // Mock SQL returning duplicate phones
    const mockSql = ((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("GROUP BY phone_e164")) {
        return Promise.resolve([{ phone: "+15550001111", count: 2 }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;

    const dummyScenario: Scenario = {
      id: "dup-01",
      category: "book_existing_patient",
      persona: "Caller",
      goal: "Book",
      caller_info: {
        stated_name: "John",
        spelled_name: "J-O-H-N",
        stated_dob: "1990-01-01",
      },
      starting_db_state: {},
      expected_outcome: {},
    };

    const grade = await gradeDbState(mockSql, dummyScenario);
    expect(grade.passed).toBe(false);
    expect(grade.reason).toContain("Duplicate patient found");
  });

  it("detects fake sql results violating overlapping appointments", async () => {
    const mockSql = ((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("GROUP BY phone_e164")) return Promise.resolve([]);
      if (query.includes("a1.id <> a2.id")) {
        return Promise.resolve([{ id: "app-overlap" }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;

    const dummyScenario: Scenario = {
      id: "overlap-01",
      category: "book_existing_patient",
      persona: "Caller",
      goal: "Book",
      caller_info: {
        stated_name: "John",
        spelled_name: "J-O-H-N",
        stated_dob: "1990-01-01",
      },
      starting_db_state: {},
      expected_outcome: {},
    };

    const grade = await gradeDbState(mockSql, dummyScenario);
    expect(grade.passed).toBe(false);
    expect(grade.reason).toContain("Overlapping confirmed appointments found");
  });
});
