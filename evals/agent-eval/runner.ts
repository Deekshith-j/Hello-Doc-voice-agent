// WHAT: Main test runner for the 30-scenario clinical agent evaluation suite.
// WHY: Executes simulated voice dialogues against an isolated test PostgreSQL database, applying
// database invariant grading, tool trace checks, and LLM judge scoring with turn and budget bounds.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  assertTestMarkerTable,
  ensureTestMarkerTable,
  isSameDatabaseProject,
  startTestDatabase,
  type TestDatabase,
} from "../../tests/support/test-database";
import { AgentHarness } from "./agent-harness";
import { gradeDbState } from "./graders/db-grader";
import { gradeWithLlmJudge } from "./graders/judge-grader";
import { gradeToolTrace } from "./graders/trace-grader";
import { BudgetExceededError, getLlmClient } from "./llm-client";
import { SimulatedPatient } from "./simulated-patient";
import type {
  ChatMessage,
  EvalSuiteResults,
  GraderResult,
  Scenario,
  ScenarioRunResult,
  ToolCallRecord,
  TranscriptTurn,
} from "./types";

const MAX_TURNS = 12;

async function seedScenarioState(
  database: TestDatabase,
  scenario: Scenario,
): Promise<void> {
  await assertTestMarkerTable(database.sql);
  await database.reset();

  // Ensure Dr. Sarah Chen and weekday schedules (morning & afternoon) are seeded alongside Dr. Test
  await database.sql`
    INSERT INTO doctors (id, full_name, specialty, timezone)
    VALUES ('10000000-0000-4000-8000-000000000002', 'Dr. Sarah Chen', 'Family Medicine', 'America/New_York')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  `;
  await database.sql`
    INSERT INTO availability_rules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
    SELECT '10000000-0000-4000-8000-000000000002', day, '09:00', '12:00', 30 
    FROM generate_series(1, 5) AS day
    ON CONFLICT DO NOTHING;
  `;
  await database.sql`
    INSERT INTO availability_rules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
    SELECT '10000000-0000-4000-8000-000000000002', day, '13:00', '17:00', 30 
    FROM generate_series(1, 5) AS day
    ON CONFLICT DO NOTHING;
  `;
  await database.sql`
    INSERT INTO availability_rules (doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
    SELECT '10000000-0000-4000-8000-000000000001', day, '13:00', '17:00', 30 
    FROM generate_series(1, 5) AS day
    ON CONFLICT DO NOTHING;
  `;

  const { starting_db_state } = scenario;

  if (starting_db_state.patient) {
    const p = starting_db_state.patient;
    await database.sql`
      INSERT INTO patients (full_name, date_of_birth, phone_e164)
      VALUES (${p.full_name}, ${p.date_of_birth}, ${p.phone})
      ON CONFLICT (phone_e164) DO NOTHING
    `;
  }

  if (starting_db_state.other_patient) {
    const op = starting_db_state.other_patient;
    await database.sql`
      INSERT INTO patients (full_name, date_of_birth, phone_e164)
      VALUES (${op.full_name}, ${op.date_of_birth}, ${op.phone})
      ON CONFLICT (phone_e164) DO NOTHING
    `;
  }

  if (starting_db_state.appointment) {
    const app = starting_db_state.appointment;
    const patientName =
      starting_db_state.other_patient?.full_name ??
      starting_db_state.patient?.full_name ??
      scenario.caller_info.stated_name;

    const patientRow = await database.sql<{ id: string }[]>`
      SELECT id FROM patients WHERE full_name = ${patientName} LIMIT 1
    `;
    const doctorRow = await database.sql<{ id: string }[]>`
      SELECT id FROM doctors LIMIT 1
    `;

    if (patientRow[0] && doctorRow[0]) {
      await database.sql`
        INSERT INTO appointments (doctor_id, patient_id, reason, time_span, status, idempotency_key)
        VALUES (${doctorRow[0].id}, ${patientRow[0].id}, 'Consultation', tstzrange(${app.start_at}, ${app.end_at}, '[)'), ${app.status}, ${'eval-seed-' + Math.random().toString(36).slice(2, 8)})
      `;
    }
  }

  if (starting_db_state.block_doctor_schedule) {
    await database.sql`
      INSERT INTO time_off (doctor_id, time_span, reason)
      SELECT id, tstzrange('2026-10-12T00:00:00Z', '2026-10-26T23:59:59Z', '[)'), 'Vacation'
      FROM doctors
    `;
  }
}

function assertTestDatabaseIsolation(mainDbUrl: string, testDbUrl: string): void {
  const isDifferentProject =
    !isSameDatabaseProject(mainDbUrl, testDbUrl) || !testDbUrl;

  console.log(
    `test database is a different project from main: ${isDifferentProject}`,
  );
  if (!isDifferentProject) {
    console.error(
      "SAFETY ERROR: Test database is not on a different project from main. Refusing to run.",
    );
    throw new Error(
      "Safety guard violation: Refusing to run evals against main project database.",
    );
  }
}

async function verifyModelAccess(
  client: ReturnType<typeof getLlmClient>,
  agentModel: string,
  judgeModel: string,
): Promise<void> {
  console.log("Running 1-call model smoke tests...");
  const agentSmoke = await client.smokeTestModel(agentModel);
  if (!agentSmoke.success) {
    throw new Error(
      `Agent model smoke test failed for ${agentModel}: ${agentSmoke.error}`,
    );
  }
  const judgeSmoke = await client.smokeTestModel(judgeModel);
  if (!judgeSmoke.success) {
    throw new Error(
      `Judge model smoke test failed for ${judgeModel}: ${judgeSmoke.error}`,
    );
  }
  console.log("✓ Models verified accessible.\n");
}

function loadScenarios(isSmoke: boolean): Scenario[] {
  const scenariosPath = path.resolve("evals/agent-eval/scenarios.json");
  const allScenarios: Scenario[] = JSON.parse(
    fs.readFileSync(scenariosPath, "utf-8"),
  );
  const scenariosToRun = isSmoke ? allScenarios.slice(0, 5) : allScenarios;

  console.log(
    `Loaded ${scenariosToRun.length} scenarios (${scenariosToRun.map((s) => s.id).join(", ")}).\n`,
  );
  return scenariosToRun;
}

interface DialogueResult {
  collectedToolCalls: ToolCallRecord[];
  errorMessage?: string;
  transcript: TranscriptTurn[];
  turnsCount: number;
}

async function runScenarioDialogue(params: {
  agentModel: string;
  harness: AgentHarness;
  patient: SimulatedPatient;
  turnLatenciesMs: number[];
}): Promise<DialogueResult> {
  const { harness, patient, agentModel, turnLatenciesMs } = params;
  const transcript: TranscriptTurn[] = [];
  const agentChatMessages: ChatMessage[] = [];
  const collectedToolCalls: ToolCallRecord[] = [];

  const openingGreeting =
    "Thanks for calling Downtown Health Clinic. Are you a new patient or have you been here before?";
  transcript.push({ role: "agent", content: openingGreeting });
  agentChatMessages.push({ role: "assistant", content: openingGreeting });

  let callerTurns = 0;
  let turnsCount = 1;
  let errorMessage: string | undefined;

  try {
    while (callerTurns < MAX_TURNS) {
      callerTurns++;
      const patientTurnStart = Date.now();
      const patientSpeech = await patient.respond(transcript);
      turnLatenciesMs.push(Date.now() - patientTurnStart);

      transcript.push({ role: "patient", content: patientSpeech });
      agentChatMessages.push({ role: "user", content: patientSpeech });
      turnsCount++;

      const agentTurnStart = Date.now();
      const agentTurnResult = await harness.runAgentTurn({
        model: agentModel,
        messages: agentChatMessages,
        onToolCall: (tc) => collectedToolCalls.push(tc),
      });
      turnLatenciesMs.push(Date.now() - agentTurnStart);

      transcript.push({
        role: "agent",
        content: agentTurnResult.reply,
        tool_calls: agentTurnResult.toolCalls,
      });
      agentChatMessages.push(...agentTurnResult.newMessages);
      turnsCount++;

      if (
        agentTurnResult.endedCall ||
        (/\b(goodbye|bye)\b/i.test(patientSpeech) &&
          /\b(goodbye|bye|have a (great|good) day|take care)\b/i.test(
            agentTurnResult.reply,
          ))
      ) {
        break;
      }

      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (turnErr) {
    if (turnErr instanceof BudgetExceededError) throw turnErr;
    errorMessage = turnErr instanceof Error ? turnErr.message : String(turnErr);
    console.warn(`  Warning in scenario run: ${errorMessage}`);
  }

  return {
    transcript,
    collectedToolCalls,
    turnsCount,
    errorMessage,
  };
}

async function gradeScenarioExecution(params: {
  collectedToolCalls: ToolCallRecord[];
  database: TestDatabase;
  failureCauses: Record<string, number>;
  judgeModel: string;
  scenario: Scenario;
  transcript: TranscriptTurn[];
}): Promise<{
  dbGrade: GraderResult;
  judgeGrade: GraderResult;
  runPassed: boolean;
  traceGrade: GraderResult;
}> {
  const { database, scenario, collectedToolCalls, transcript, judgeModel, failureCauses } = params;

  const dbGrade = await gradeDbState(database.sql, scenario);
  const traceGrade = gradeToolTrace(scenario, collectedToolCalls, transcript);
  const judgeGrade = await gradeWithLlmJudge(scenario, transcript, judgeModel);

  const runPassed = dbGrade.passed && traceGrade.passed && judgeGrade.passed;

  if (!runPassed) {
    if (!dbGrade.passed) {
      const cause = `DB State: ${dbGrade.reason}`;
      failureCauses[cause] = (failureCauses[cause] ?? 0) + 1;
    }
    if (!traceGrade.passed) {
      const cause = `Tool Trace: ${traceGrade.reason}`;
      failureCauses[cause] = (failureCauses[cause] ?? 0) + 1;
    }
    if (!judgeGrade.passed) {
      const cause = `Judge Rubric: ${judgeGrade.reason}`;
      failureCauses[cause] = (failureCauses[cause] ?? 0) + 1;
    }
  }

  return { runPassed, dbGrade, traceGrade, judgeGrade };
}

function computeSuiteSummary(params: {
  agentModel: string;
  client: ReturnType<typeof getLlmClient>;
  failureCauses: Record<string, number>;
  isSmoke: boolean;
  judgeModel: string;
  patientModel: string;
  retellDeployedModel: string;
  runs: ScenarioRunResult[];
  turnLatenciesMs: number[];
}): EvalSuiteResults {
  const {
    agentModel,
    client,
    failureCauses,
    isSmoke,
    judgeModel,
    patientModel,
    retellDeployedModel,
    runs,
    turnLatenciesMs,
  } = params;

  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.passed).length;
  const overallPassRate = totalRuns > 0 ? (passedRuns / totalRuns) * 100 : 0;

  turnLatenciesMs.sort((a, b) => a - b);
  const medianLatencyMs =
    turnLatenciesMs.length > 0
      ? turnLatenciesMs[Math.floor(turnLatenciesMs.length / 2)]
      : 0;

  const categoryPassRates: Record<
    string,
    { pass_rate: number; passed: number; total: number }
  > = {};
  for (const run of runs) {
    if (!categoryPassRates[run.category]) {
      categoryPassRates[run.category] = { total: 0, passed: 0, pass_rate: 0 };
    }
    categoryPassRates[run.category].total++;
    if (run.passed) categoryPassRates[run.category].passed++;
  }
  for (const cat in categoryPassRates) {
    const item = categoryPassRates[cat];
    item.pass_rate = Number(((item.passed / item.total) * 100).toFixed(1));
  }

  return {
    timestamp: new Date().toISOString(),
    suite_mode: isSmoke ? "smoke" : "full",
    models: {
      agent_model: agentModel,
      patient_model: patientModel,
      judge_model: judgeModel,
      retell_deployed_model: retellDeployedModel,
    },
    budget: {
      cap_usd: client.getHardCap(),
      spent_usd: Number(client.getTotalCost().toFixed(4)),
    },
    summary: {
      total_runs: totalRuns,
      passed_runs: passedRuns,
      overall_pass_rate: Number(overallPassRate.toFixed(1)),
      median_latency_per_turn_ms: medianLatencyMs,
      total_tokens: client.getTotalTokens().total,
      total_cost_usd: Number(client.getTotalCost().toFixed(4)),
    },
    category_pass_rates: categoryPassRates,
    failure_causes: failureCauses,
    runs,
  };
}

function persistAndPrintResults(results: EvalSuiteResults, isSmoke: boolean): void {
  const outputDir = path.resolve("evals/results");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filename = `agent-eval-${isSmoke ? "smoke" : "full"}-${Date.now()}.json`;
  const outputPath = path.join(outputDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  console.log(`\n========================================================`);
  console.log(`  EVALUATION SUMMARY`);
  console.log(`========================================================`);
  console.log(`Mode: ${results.suite_mode.toUpperCase()}`);
  console.log(
    `Total Runs: ${results.summary.total_runs} | Passed: ${results.summary.passed_runs} | Pass Rate: ${results.summary.overall_pass_rate}%`,
  );
  console.log(
    `Median Latency per turn: ${results.summary.median_latency_per_turn_ms} ms`,
  );
  console.log(`Total Tokens: ${results.summary.total_tokens}`);
  console.log(`Total Run Cost: $${results.summary.total_cost_usd} USD`);
  console.log(`Saved Results to: ${outputPath}\n`);

  console.log("Category Pass Rates:");
  for (const [cat, data] of Object.entries(results.category_pass_rates)) {
    console.log(
      `  - ${cat.padEnd(32)}: ${data.passed}/${data.total} (${data.pass_rate}%)`,
    );
  }

  if (Object.keys(results.failure_causes).length > 0) {
    console.log("\nFailure Causes:");
    for (const [cause, count] of Object.entries(results.failure_causes)) {
      console.log(`  - [${count}x] ${cause}`);
    }
  }
}

export async function runAgentEval(options?: {
  mode?: "smoke" | "full";
  n?: number;
}): Promise<EvalSuiteResults> {
  const isSmoke = options?.mode === "smoke";
  const repetitions = options?.n ?? (isSmoke ? 1 : 3);

  console.log("\n========================================================");
  console.log(`  AGENT EVALUATION SUITE (${isSmoke ? "SMOKE TEST" : "FULL RUN"})`);
  console.log(`  Repetitions per scenario: N = ${repetitions}`);
  console.log("========================================================\n");

  assertTestDatabaseIsolation(process.env.DATABASE_URL || "", process.env.TEST_DATABASE_URL || "");

  const client = getLlmClient();
  const agentModel = process.env.EVAL_AGENT_MODEL || "gpt-4o-mini";
  const patientModel = process.env.EVAL_PATIENT_MODEL || "gpt-4o-mini";
  const judgeModel = process.env.EVAL_JUDGE_MODEL || "gpt-4o";
  const retellDeployedModel = "gpt-6-luna";

  console.log(`Provider: ${client.getProviderName()}`);
  console.log(`Agent Model: ${agentModel}`);
  console.log(`Simulated Patient Model: ${patientModel}`);
  console.log(`Judge Model: ${judgeModel}`);
  console.log(`Retell Deployed Model: ${retellDeployedModel}`);
  console.log(`Hard Budget Cap: $${client.getHardCap().toFixed(2)} USD\n`);

  await verifyModelAccess(client, agentModel, judgeModel);
  const scenariosToRun = loadScenarios(isSmoke);

  const database = await startTestDatabase();
  await ensureTestMarkerTable(database.sql);

  const runs: ScenarioRunResult[] = [];
  const turnLatenciesMs: number[] = [];
  const failureCauses: Record<string, number> = {};

  try {
    for (const scenario of scenariosToRun) {
      for (let runIdx = 1; runIdx <= repetitions; runIdx++) {
        console.log(
          `Running [${scenario.id}] (run ${runIdx}/${repetitions}) - ${scenario.category}...`,
        );

        await seedScenarioState(database, scenario);

        const harness = new AgentHarness(database);
        const patient = new SimulatedPatient(scenario, patientModel);
        const runStartTime = Date.now();

        const dialogue = await runScenarioDialogue({
          harness,
          patient,
          agentModel,
          turnLatenciesMs,
        });

        const grades = await gradeScenarioExecution({
          database,
          scenario,
          collectedToolCalls: dialogue.collectedToolCalls,
          transcript: dialogue.transcript,
          judgeModel,
          failureCauses,
        });

        const runDurationMs = Date.now() - runStartTime;
        const runTokens = client.getTotalTokens();
        const runCost = client.getTotalCost();

        runs.push({
          scenario_id: scenario.id,
          category: scenario.category,
          run_index: runIdx,
          passed: grades.runPassed,
          transcript: dialogue.transcript,
          tool_calls: dialogue.collectedToolCalls,
          grades: {
            db_state: grades.dbGrade,
            tool_trace: grades.traceGrade,
            llm_judge: grades.judgeGrade,
          },
          turns_count: dialogue.turnsCount,
          duration_ms: runDurationMs,
          tokens: {
            prompt_tokens: runTokens.prompt,
            completion_tokens: runTokens.completion,
            total_tokens: runTokens.total,
          },
          cost_usd: runCost,
          error: dialogue.errorMessage,
        });

        console.log(
          `  Result: ${grades.runPassed ? "PASS" : "FAIL"} (DB: ${grades.dbGrade.passed ? "✓" : "✗"}, Trace: ${grades.traceGrade.passed ? "✓" : "✗"}, Judge: ${grades.judgeGrade.passed ? "✓" : "✗"}) [Cost: $${client.getTotalCost().toFixed(4)}]`,
        );
      }
    }
  } finally {
    await database.close();
  }

  const results = computeSuiteSummary({
    agentModel,
    client,
    failureCauses,
    isSmoke,
    judgeModel,
    patientModel,
    retellDeployedModel,
    runs,
    turnLatenciesMs,
  });

  persistAndPrintResults(results, isSmoke);
  return results;
}

if (process.argv[1]?.includes("runner")) {
  const isSmoke =
    process.argv.includes("--smoke") || !process.argv.includes("--full");
  runAgentEval({ mode: isSmoke ? "smoke" : "full" }).catch((err) => {
    console.error("Evaluation run failed:", err);
    process.exit(1);
  });
}
