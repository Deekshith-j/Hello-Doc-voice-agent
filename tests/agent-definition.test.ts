import { describe, expect, it } from "vitest";

import {
  buildPrompt,
  buildRetellLlm,
  renderPrompt,
  toolNames,
} from "@/integrations/retell/agent-definition";

const testSettings = {
  clinicName: "Downtown Health Clinic",
  clinicTimeZone: "America/New_York",
  model: "gpt-6-luna",
  publicBaseUrl: "https://docto-agent.vercel.app",
  voiceId: "retell-Cimo",
};

describe("agent-definition prompt and configuration", () => {
  it("builds an LLM configuration with triage opening and dynamic variables", () => {
    const llm = buildRetellLlm(testSettings);

    expect(llm.model).toBe("gpt-6-luna");
    expect(llm.start_speaker).toBe("agent");
    expect(llm.begin_message).toBe(
      "Thanks for calling Downtown Health Clinic. Are you a new patient or have you been here before?",
    );
    expect(llm.default_dynamic_variables).toMatchObject({
      clinic_name: "Downtown Health Clinic",
      emergency_number: "911",
    });
    expect(typeof llm.default_dynamic_variables.current_time).toBe("string");
  });

  it("includes all 9 expected tools in the LLM tool list", () => {
    const llm = buildRetellLlm(testSettings);
    const names = llm.general_tools.map(
      (t: { name?: string }) => t.name,
    );

    expect(names).toEqual([
      "end_call",
      "list_doctors",
      "find_patient",
      "create_patient",
      "check_availability",
      "book_appointment",
      "list_patient_appointments",
      "reschedule_appointment",
      "cancel_appointment",
    ]);
    expect(toolNames()).toHaveLength(8);
  });

  it("structures the system prompt cleanly and keeps it under 700 words", () => {
    const prompt = buildPrompt();

    // Required sections
    expect(prompt).toContain("# Role");
    expect(prompt).toContain("# Style");
    expect(prompt).toContain("# Call Flow");
    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("# Rules");
    expect(prompt).toContain("# Error Handling");

    // Key requirements
    expect(prompt).toContain("Are you a new patient or have you been here before?");
    expect(prompt).toContain("find_patient");
    expect(prompt).toContain("create_patient");
    expect(prompt).toContain("{{emergency_number}}");
    expect(prompt).toContain("{{current_time}}");

    // Word count under 700
    const words = prompt.trim().split(/\s+/).length;
    expect(words).toBeLessThan(700);

    // Dynamic variable validation: only allowed variables
    const matches = [...prompt.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map(
      (m) => m[1],
    );
    const distinctVars = new Set(matches);
    expect(distinctVars).toEqual(
      new Set(["clinic_name", "emergency_number", "current_time"]),
    );
  });

  it("renders the prompt with real values filled in without unreplaced placeholders", () => {
    const rendered = renderPrompt(testSettings);

    expect(rendered).toContain("Downtown Health Clinic");
    expect(rendered).toContain("911");
    expect(rendered).not.toContain("{{clinic_name}}");
    expect(rendered).not.toContain("{{emergency_number}}");
    expect(rendered).not.toContain("{{current_time}}");
  });
});
