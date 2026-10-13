# Evaluation Suites

This directory contains automated evaluations for the Docto clinical appointment agent, running strictly in TEXT mode against isolated test databases without burning Retell credits or making voice calls.

---

## 1. Conversational Agent Evaluation Suite (`evals/agent-eval/`)

Tests the real agent system prompt from `src/integrations/retell/agent-definition.ts` and all 8 real backend tools against 30 multi-turn clinical scenarios using a simulated patient LLM and 3 independent graders.

### Commands

```bash
# Smoke test: 5 scenarios, N=1 repetition
npm run eval:agent -- --smoke

# Full evaluation: 30 scenarios, N=3 repetitions
npm run eval:agent -- --full

# Judge calibration against hand labels
npm run eval:calibrate
```

### Graders
1. **DB-State Grader**: Verifies database invariants on the isolated test database (valid appointment booked/rescheduled/cancelled, no overlapping doctor appointments, no past bookings, no duplicate patient records, no cross-patient data pollution).
2. **Tool-Trace Grader**: Validates sequence integrity (`find_patient`/`create_patient` before any booking action, `check_availability` before `book_appointment`, tool arguments match caller statements, and caller confirmation precedes booking mutations).
3. **LLM Judge**: Evaluates conversation transcript against a written clinical rubric (safety, refusal of medical advice, immediate 911 redirection for emergencies, prompt injection resistance, voice brevity, conversational times, no leaked PHI).

### Hard Budget Cap
* Enforces a hard budget ceiling of **$2.00 USD** per run in code. If total token spending reaches $2.00, execution halts immediately and saves all completed results.

---

## 2. Tool API Regression Suite (`evals/tool-api-suite/tool-api-regression-suite.ts`)

Regression testing for backend tool HTTP adapters, concurrency limits, and database contracts:
```bash
npm run eval
```

---

## Known Limitations

* **Retell Deployed Model vs. Text-Mode Eval Model**:
  * The production Retell agent is configured with `gpt-6-luna` (`RETELL_LLM_MODEL` in `setup.ts`), a voice model hosted inside Retell AI's platform.
  * Because `gpt-6-luna` cannot be called directly over standard text LLM APIs, text-mode evaluations run with `EVAL_AGENT_MODEL` (default: `gpt-4o-mini`).
  * Both environments share the exact same system prompt, tool schemas, and business logic adapters.
