// WHAT: LLM-driven simulated patient generating realistic voice caller dialogue for test scenarios.
// WHY: Emulates diverse caller behaviors (e.g. spelling names, clarifying times, vague requests, emergency symptoms)
// to rigorously stress-test the voice agent under realistic conversational variance.
import { getLlmClient } from "./llm-client";
import type { Scenario, TranscriptTurn } from "./types";

export class SimulatedPatient {
  constructor(
    private scenario: Scenario,
    private model: string = "gemini-2.5-flash",
  ) {}

  async respond(history: TranscriptTurn[]): Promise<string> {
    const client = getLlmClient();

    const isExisting = Boolean(
      this.scenario.starting_db_state.patient ||
      this.scenario.category === "book_existing_patient" ||
      this.scenario.category === "reschedule" ||
      this.scenario.category === "cancel" ||
      this.scenario.category === "vague_dates" ||
      this.scenario.category === "taken_slot" ||
      this.scenario.category === "caller_changes_mind"
    );

    const systemPrompt = `You are roleplaying as a caller in a phone call with a clinic scheduling assistant.
Your Persona: ${this.scenario.persona}
Your Goal: ${this.scenario.goal}
Your Status: ${isExisting ? "EXISTING patient (you have visited this clinic before)." : "NEW patient (first-time caller, never been here before)."}

Your Information:
- Full Name: ${this.scenario.caller_info.stated_name}
- Name Spelling: ${this.scenario.caller_info.spelled_name}
- Date of Birth: ${this.scenario.caller_info.stated_dob}
- Phone Number: ${this.scenario.caller_info.stated_phone ?? "N/A"}

Rules for your roleplay:
1. Speak naturally as a caller on the phone in one or two short sentences per turn.
2. If the agent asks "Are you a new patient or have you been here before?", answer clearly: ${isExisting ? '"I am an existing patient / I have been here before."' : '"I am a new patient."'}.
3. If the agent asks for your name, date of birth, or phone number, provide the requested information from Your Information (if multiple are asked, provide all of them together).
4. If the agent offers available slots, choose one that fits your goal and confirm clearly (e.g. "Yes, the 9:00 AM slot works for me, please book that.").
5. If the agent reads back your details or asks for confirmation before booking, rescheduling, or cancelling (such as "Would you like me to book that for you?"), clearly say: "Yes, that works, please go ahead and confirm that."
6. If you achieve your goal, or the agent advises you to call the front desk or dial 911, acknowledge and say goodbye.
7. Do not break character. Do not output anything other than your spoken phone response.`;

    const formattedHistory = history
      .map(
        (turn) =>
          `${turn.role === "agent" ? "Clinic Assistant" : "You (Caller)"}: ${turn.content}`,
      )
      .join("\n");

    const userPrompt = `Conversation so far:\n${formattedHistory}\n\nRespond to the clinic assistant as the caller:`;

    const res = await client.chatCompletion({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 80,
    });

    return res.message.content?.trim() || "Thank you, goodbye.";
  }
}
