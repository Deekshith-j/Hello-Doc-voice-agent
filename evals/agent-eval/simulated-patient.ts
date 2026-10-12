import { getLlmClient } from "./llm-client";
import type { Scenario, TranscriptTurn } from "./types";

export class SimulatedPatient {
  constructor(
    private scenario: Scenario,
    private model: string = "gemini-2.5-flash",
  ) {}

  async respond(history: TranscriptTurn[]): Promise<string> {
    const client = getLlmClient();

    const systemPrompt = `You are roleplaying as a caller in a phone call with a clinic scheduling assistant.
Your Persona: ${this.scenario.persona}
Your Goal: ${this.scenario.goal}

Your Information:
- Full Name: ${this.scenario.caller_info.stated_name}
- Name Spelling: ${this.scenario.caller_info.spelled_name}
- Date of Birth: ${this.scenario.caller_info.stated_dob}
- Phone Number: ${this.scenario.caller_info.stated_phone ?? "N/A"}

Rules for your roleplay:
1. Speak naturally as a caller on the phone in one or two short sentences per turn.
2. Answer the agent's questions according to your persona and goal.
3. If the agent asks for your name or to spell it, provide the spelling from Your Information.
4. If you have achieved your goal or completed booking/cancellation, say thank you and goodbye.
5. If the agent tells you to hang up and dial 911 for an emergency, acknowledge immediately and say you are calling 911 now.
6. Do not break character. Do not output anything other than your spoken phone response.`;

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
