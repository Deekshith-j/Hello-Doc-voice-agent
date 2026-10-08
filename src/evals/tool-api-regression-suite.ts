// Tool API regression suite.
// Exercises every tool scenario against an isolated, freshly seeded database and reports the results.
// Note: This is a tool API regression suite, NOT the Part B agent eval harness.
import type { EvalCaseResult } from "@/db/postgres-dashboard-repository";

import { CaseRecorder } from "./checks";
import { scenarios } from "./scenarios";
import { ToolClient } from "./tool-client";

const SUITE = "tool API regression suite";
const EVAL_SIGNING_KEY = "eval-only-signing-key";

// Captured before the harness points the app at its own isolated database.
const resultsDatabaseUrl = process.env.DATABASE_URL;

const { startEmbeddedDatabase } = await import("@/db/embedded-database");
const { seedDatabase } = await import("@/db/seed-database");
const database = await startEmbeddedDatabase();
await seedDatabase(database.url);
process.env.DATABASE_URL = database.url;
process.env.RETELL_API_KEY = EVAL_SIGNING_KEY;
// Google is disabled so evals measure this system, not an external calendar.
for (const key of [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
])
  delete process.env[key];
console.info = () => {};

const client = new ToolClient(await loadRoutes(), EVAL_SIGNING_KEY);
const startedAt = new Date();
const results: EvalCaseResult[] = [];
for (const scenario of scenarios) results.push(await runScenario(scenario));
const finishedAt = new Date();

const passed = results.filter((result) => result.passed).length;
printReport(results, passed);
await saveRun(results, passed, startedAt, finishedAt);
await database.close();
process.exit(passed === results.length ? 0 : 1);

async function runScenario(
  scenario: (typeof scenarios)[number],
): Promise<EvalCaseResult> {
  const check = new CaseRecorder();
  const began = performance.now();
  try {
    await scenario.run(client, check);
  } catch (error) {
    check.expect(
      "scenario completes",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    name: scenario.name,
    passed:
      check.checks.length > 0 && check.checks.every((item) => item.passed),
    durationMs: Math.round(performance.now() - began),
    checks: check.checks,
  };
}

async function loadRoutes() {
  const load = async (path: string) =>
    (
      (await import(`@/app/api/tools/${path}/route`)) as {
        POST: (request: Request) => Promise<Response>;
      }
    ).POST;
  return {
    list_doctors: await load("list-doctors"),
    find_patient: await load("find-patient"),
    check_availability: await load("check-availability"),
    book_appointment: await load("book-appointment"),
    list_patient_appointments: await load("list-patient-appointments"),
    reschedule_appointment: await load("reschedule-appointment"),
    cancel_appointment: await load("cancel-appointment"),
  };
}

function printReport(cases: EvalCaseResult[], passedCount: number): void {
  for (const result of cases) {
    console.log(
      `${result.passed ? "PASS" : "FAIL"}  ${result.name}  (${result.durationMs} ms)`,
    );
    for (const item of result.checks.filter((entry) => !entry.passed))
      console.log(`      ✗ ${item.name}: ${item.detail}`);
  }
  console.log(`\n${passedCount}/${cases.length} scenarios passed.`);
}

async function saveRun(
  cases: EvalCaseResult[],
  passedCount: number,
  started: Date,
  finished: Date,
): Promise<void> {
  if (!resultsDatabaseUrl) {
    console.log("DATABASE_URL is not set, so this run was not saved.");
    return;
  }
  const { createSqlClient } = await import("@/db/client");
  const { PostgresDashboardRepository } =
    await import("@/db/postgres-dashboard-repository");
  const sql = createSqlClient(resultsDatabaseUrl);
  try {
    await new PostgresDashboardRepository(sql).saveEvalRun({
      suite: SUITE,
      startedAt: started,
      finishedAt: finished,
      passed: passedCount,
      failed: cases.length - passedCount,
      results: cases,
    });
    console.log("Saved this run to the Evaluations page.");
  } catch {
    console.log(
      "Could not connect to DATABASE_URL to save results (start local DB with `npm run db:local` to persist runs).",
    );
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      // Ignore cleanup error if connection wasn't established
    }
  }
}
