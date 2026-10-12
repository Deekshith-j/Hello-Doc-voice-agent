export type ScenarioCategory =
  | "book_existing_patient"
  | "register_new_patient_then_book"
  | "reschedule"
  | "cancel"
  | "vague_dates"
  | "no_availability"
  | "caller_changes_mind"
  | "taken_slot"
  | "wrong_dob"
  | "unknown_patient"
  | "medical_advice"
  | "emergency"
  | "prompt_injection"
  | "asking_for_another_patient_data"
  | "misheard_name_spelling";

export interface ScenarioFixtureData {
  patient?: {
    full_name: string;
    date_of_birth: string;
    phone: string;
  };
  other_patient?: {
    full_name: string;
    date_of_birth: string;
    phone: string;
  };
  appointment?: {
    doctor_name?: string;
    start_at: string;
    end_at: string;
    status: "confirmed" | "cancelled";
  };
  block_doctor_schedule?: boolean;
}

export interface ExpectedOutcome {
  should_book?: boolean;
  should_reschedule?: boolean;
  should_cancel?: boolean;
  should_register?: boolean;
  should_end_early?: boolean;
  emergency_handled?: boolean;
  medical_advice_refused?: boolean;
  injection_resisted?: boolean;
  no_phi_leak?: boolean;
  require_front_desk_offer?: boolean;
}

export interface Scenario {
  id: string;
  category: ScenarioCategory;
  persona: string;
  goal: string;
  caller_info: {
    stated_name: string;
    spelled_name: string;
    stated_dob: string;
    stated_phone?: string;
  };
  starting_db_state: ScenarioFixtureData;
  expected_outcome: ExpectedOutcome;
}

export interface ToolCallRecord {
  tool_name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  timestamp: number;
}

export interface TranscriptTurn {
  role: "patient" | "agent";
  content: string;
  tool_calls?: ToolCallRecord[];
}

export interface GraderResult {
  passed: boolean;
  reason: string;
}

export interface ScenarioRunResult {
  scenario_id: string;
  category: ScenarioCategory;
  run_index: number;
  passed: boolean;
  transcript: TranscriptTurn[];
  tool_calls: ToolCallRecord[];
  grades: {
    db_state: GraderResult;
    tool_trace: GraderResult;
    llm_judge: GraderResult;
  };
  turns_count: number;
  duration_ms: number;
  tokens: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost_usd: number;
  error?: string;
}

export interface EvalSuiteResults {
  timestamp: string;
  suite_mode: "smoke" | "full";
  models: {
    agent_model: string;
    patient_model: string;
    judge_model: string;
    retell_deployed_model: string;
  };
  budget: {
    cap_usd: number;
    spent_usd: number;
  };
  summary: {
    total_runs: number;
    passed_runs: number;
    overall_pass_rate: number;
    median_latency_per_turn_ms: number;
    total_tokens: number;
    total_cost_usd: number;
  };
  category_pass_rates: Record<string, { total: number; passed: number; pass_rate: number }>;
  failure_causes: Record<string, number>;
  runs: ScenarioRunResult[];
}
