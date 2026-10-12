// WHAT: Evaluator calibration runner benchmarking LLM judge accuracy against hand-labeled transcripts.
// WHY: Ensures the judge model's rubric alignment matches human clinical supervision before relying on it
// for automated regression testing and scoring.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { gradeWithLlmJudge } from "./graders/judge-grader";
import type { Scenario, ScenarioCategory, TranscriptTurn } from "./types";

interface HandLabelItem {
  id: string;
  category: string;
  transcript: TranscriptTurn[];
  scenario?: Partial<Scenario>;
  human_label: boolean | null;
  human_notes: string;
}

export async function runCalibration(): Promise<void> {
  const handLabelsPath = path.resolve("evals/hand-labels.json");
  const blankLabelsPath = path.resolve("evals/blank-labels.json");

  // 1. Generate blank labelling sheet of 15 transcripts if requested or if not existing
  const scenariosPath = path.resolve("evals/agent-eval/scenarios.json");
  const scenarios: Scenario[] = JSON.parse(
    fs.readFileSync(scenariosPath, "utf-8"),
  );

  const sampleScenarios = scenarios.slice(0, 15);
  const blankSheet: HandLabelItem[] = sampleScenarios.map((s, idx) => ({
    id: `label-sample-${idx + 1}-${s.id}`,
    category: s.category,
    scenario: {
      category: s.category,
      persona: s.persona,
      goal: s.goal,
      caller_info: s.caller_info,
    },
    transcript: [
      {
        role: "agent",
        content:
          "Thanks for calling Downtown Health Clinic. Are you a new patient or have you been here before?",
      },
      {
        role: "patient",
        content: `Hi, I am ${s.caller_info.stated_name}, ${s.goal}`,
      },
    ],
    human_label: null,
    human_notes: "",
  }));

  fs.writeFileSync(blankLabelsPath, JSON.stringify(blankSheet, null, 2));
  console.log(
    `[Calibration] Generated blank labelling sheet for 15 transcripts at: ${blankLabelsPath}`,
  );

  // 2. Check if hand-labels.json exists and has labels
  if (!fs.existsSync(handLabelsPath)) {
    console.log(
      `[Calibration] No ${handLabelsPath} found yet. Fill in ${blankLabelsPath} and save as evals/hand-labels.json to calibrate.`,
    );
    return;
  }

  const handLabels: HandLabelItem[] = JSON.parse(
    fs.readFileSync(handLabelsPath, "utf-8"),
  );
  const labeled = handLabels.filter((h) => h.human_label !== null);

  if (labeled.length === 0) {
    console.log(
      `[Calibration] ${handLabelsPath} has 0 human-labelled items. Please set 'human_label: true/false' on items.`,
    );
    return;
  }

  console.log(
    `[Calibration] Calibrating LLM judge against ${labeled.length} hand-labelled items...`,
  );

  let agreements = 0;
  const disagreements: {
    id: string;
    human: boolean;
    judge: boolean;
    reason: string;
  }[] = [];

  for (const item of labeled) {
    const fakeScenario: Scenario = {
      id: item.id,
      category: item.category as ScenarioCategory,
      persona: item.scenario?.persona || "Caller",
      goal: item.scenario?.goal || "Goal",
      caller_info: item.scenario?.caller_info || {
        stated_name: "Patient",
        spelled_name: "P-A-T-I-E-N-T",
        stated_dob: "1990-01-01",
      },
      starting_db_state: {},
      expected_outcome: {},
    };

    const judgeResult = await gradeWithLlmJudge(fakeScenario, item.transcript);
    const agree = judgeResult.passed === item.human_label;
    if (agree) {
      agreements++;
    } else {
      disagreements.push({
        id: item.id,
        human: Boolean(item.human_label),
        judge: judgeResult.passed,
        reason: judgeResult.reason,
      });
    }
  }

  const accuracy = (agreements / labeled.length) * 100;
  console.log(`\n=== JUDGE CALIBRATION REPORT ===`);
  console.log(`Total Hand-labelled items: ${labeled.length}`);
  console.log(`Agreements: ${agreements} / ${labeled.length}`);
  console.log(`Judge Agreement Rate: ${accuracy.toFixed(1)}%`);

  if (disagreements.length > 0) {
    console.log(`\nDisagreements (${disagreements.length}):`);
    for (const d of disagreements) {
      console.log(
        `- [${d.id}] Human: ${d.human ? "PASS" : "FAIL"} | Judge: ${d.judge ? "PASS" : "FAIL"} (${d.reason})`,
      );
    }
  }
}

if (process.argv[1]?.endsWith("calibrate.ts")) {
  runCalibration().catch((err) => {
    console.error("Calibration failed:", err);
    process.exit(1);
  });
}
