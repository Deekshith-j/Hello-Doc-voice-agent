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
  Scenario,
  ScenarioRunResult,
  TranscriptTurn,
} from "./types";

const MAX_TURNS = 12;

async function seedScenarioState(
  database: TestDatabase,
  scenario: Scenario,
): Promise<void> {
  await assertTestMarkerTable(database.sql);
  await database.reset();

  const { starting_db_state } = scenario;

  // Insert primary patient if specified
  if (starting_db_state.patient) {
    const p = starting_db_state.patient;
    await database.sql`
      INSERT INTO patients (full_name, date_of_birth, phone_e164)
      VALUES (${p.full_name}, ${p.date_of_birth}, ${p.phone})
      ON CONFLICT (phone_e164) DO NOTHING
    `;
  }

  // Insert other patient if specified
  if (starting_db_state.other_patient) {
    const op = starting_db_state.other_patient;
    await database.sql`
      INSERT INTO patients (full_name, date_of_birth, phone_e164)
      VALUES (${op.full_name}, ${op.date_of_birth}, ${op.phone})
      ON CONFLICT (phone_e164) DO NOTHING
    `;
  }

  // Insert appointment if specified
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
        INSERT INTO appointments (doctor_id, patient_id, reason, start_at, end_at, status, idempotency_key)
        VALUES (${doctorRow[0].id}, ${patientRow[0].id}, 'Consultation', ${app.start_at}, ${app.end_at}, ${app.status}, ${'eval-seed-' + Math.random().toString(36).slice(2, 8)})
      `;
    }
  }

  // Block doctor schedule if specified
  if (starting_db_state.block_doctor_schedule) {
    await database.sql`
      INSERT INTO time_off (doctor_id, start_at, end_at, reason)
      SELECT id, '2026-10-12T00:00:00Z', '2026-10-26T23:59:59Z', 'Vacation'
      FROM doctors
    `;
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

  // 1. Safety Guard: Check database isolation
  const mainDbUrl = process.env.DATABASE_URL || "";
  const testDbUrl = process.env.TEST_DATABASE_URL || "";
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

  // 2. Initialize Models and Client
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

  // 3. Smoke Test Models
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

  // 4. Load Scenarios
  const scenariosPath = path.resolve("evals/agent-eval/scenarios.json");
  const allScenarios: Scenario[] = JSON.parse(
    fs.readFileSync(scenariosPath, "utf-8"),
  );
  const scenariosToRun = isSmoke ? allScenarios.slice(0, 5) : allScenarios;

  console.log(
    `Loaded ${scenariosToRun.length} scenarios (${scenariosToRun.map((s) => s.id).join(", ")}).\n`,
  );

  // 5. Setup Database
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

        const transcript: TranscriptTurn[] = [];
        const agentChatMessages: ChatMessage[] = [];
        const collectedToolCalls: import("./types").ToolCallRecord[] = [];

        // Initial agent turn: Opening Greeting
        const openingGreeting =
          "Thanks for calling Downtown Health Clinic. Are you a new patient or have you been here before?";
        transcript.push({ role: "agent", content: openingGreeting });
        agentChatMessages.push({ role: "assistant", content: openingGreeting });

        let turnsCount = 1;
        const runStartTime = Date.now();
        let runPassed = false;
        let errorMessage: string | undefined;

        try {
          while (turnsCount < MAX_TURNS) {
            // Patient turn
            const patientTurnStart = Date.now();
            const patientSpeech = await patient.respond(transcript);
            turnLatenciesMs.push(Date.now() - patientTurnStart);

            transcript.push({ role: "patient", content: patientSpeech });
            agentChatMessages.push({ role: "user", content: patientSpeech });
            turnsCount++;

            // Agent turn
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
            agentChatMessages.push({
              role: "assistant",
              content: agentTurnResult.reply,
            });
            turnsCount++;

            if (agentTurnResult.endedCall) {
              break;
            }
          }
        } catch (turnErr) {
          if (turnErr instanceof BudgetExceededError) throw turnErr;
          errorMessage =
            turnErr instanceof Error ? turnErr.message : String(turnErr);
          console.warn(`  Warning in scenario run: ${errorMessage}`);
        }

        const runDurationMs = Date.now() - runStartTime;

        // Run the 3 Graders
        const dbGrade = await gradeDbState(database.sql, scenario);
        const traceGrade = gradeToolTrace(
          scenario,
          collectedToolCalls,
          transcript,
        );
        const judgeGrade = await gradeWithLlmJudge(
          scenario,
          transcript,
          judgeModel,
        );

        runPassed = dbGrade.passed && traceGrade.passed && judgeGrade.passed;

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

        const runTokens = client.getTotalTokens();
        const runCost = client.getTotalCost();

        runs.push({
          scenario_id: scenario.id,
          category: scenario.category,
          run_index: runIdx,
          passed: runPassed,
          transcript,
          tool_calls: collectedToolCalls,
          grades: {
            db_state: dbGrade,
            tool_trace: traceGrade,
            llm_judge: judgeGrade,
          },
          turns_count: turnsCount,
          duration_ms: runDurationMs,
          tokens: {
            prompt_tokens: runTokens.prompt,
            completion_tokens: runTokens.completion,
            total_tokens: runTokens.total,
          },
          cost_usd: runCost,
          error: errorMessage,
        });

        console.log(
          `  Result: ${runPassed ? "PASS" : "FAIL"} (DB: ${dbGrade.passed ? "✓" : "✗"}, Trace: ${traceGrade.passed ? "✓" : "✗"}, Judge: ${judgeGrade.passed ? "✓" : "✗"}) [Cost: $${client.getTotalCost().toFixed(4)}]`,
        );
      }
    }
  } finally {
    await database.close();
  }

  // 6. Aggregate Statistics
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
    { total: number; passed: number; pass_rate: number }
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

  const results: EvalSuiteResults = {
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

  // 7. Save Results JSON
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
    `Total Runs: ${totalRuns} | Passed: ${passedRuns} | Pass Rate: ${results.summary.overall_pass_rate}%`,
  );
  console.log(`Median Latency per turn: ${medianLatencyMs} ms`);
  console.log(`Total Tokens: ${results.summary.total_tokens}`);
  console.log(`Total Run Cost: $${results.summary.total_cost_usd} USD`);
  console.log(`Saved Results to: ${outputPath}\n`);

  console.log("Category Pass Rates:");
  for (const [cat, data] of Object.entries(categoryPassRates)) {
    console.log(
      `  - ${cat.padEnd(32)}: ${data.passed}/${data.total} (${data.pass_rate}%)`,
    );
  }

  if (Object.keys(failureCauses).length > 0) {
    console.log("\nFailure Causes:");
    for (const [cause, count] of Object.entries(failureCauses)) {
      console.log(`  - [${count}x] ${cause}`);
    }
  }

  return results;
}

// CLI execution
if (process.argv[1]?.endsWith("runner.ts")) {
  const isSmoke =
    process.argv.includes("--smoke") || !process.argv.includes("--full");
  runAgentEval({ mode: isSmoke ? "smoke" : "full" }).catch((err) => {
    console.error("Evaluation run failed:", err);
    process.exit(1);
  });
}
