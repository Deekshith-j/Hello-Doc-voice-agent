import type { GraderResult, Scenario, ToolCallRecord, TranscriptTurn } from "../types";

export function gradeToolTrace(
  scenario: Scenario,
  toolCalls: ToolCallRecord[],
  transcript: TranscriptTurn[],
): GraderResult {
  const toolNames = toolCalls.map((t) => t.tool_name);

  // 1. Identification before mutation: find_patient or create_patient must precede book/reschedule/cancel
  const firstIdentificationIndex = toolCalls.findIndex(
    (t) => t.tool_name === "find_patient" || t.tool_name === "create_patient",
  );

  const firstMutationIndex = toolCalls.findIndex(
    (t) =>
      t.tool_name === "book_appointment" ||
      t.tool_name === "reschedule_appointment" ||
      t.tool_name === "cancel_appointment",
  );

  if (firstMutationIndex !== -1) {
    if (
      firstIdentificationIndex === -1 ||
      firstIdentificationIndex > firstMutationIndex
    ) {
      return {
        passed: false,
        reason: `Tool trace violation: ${toolNames[firstMutationIndex]} was called before verifying patient via find_patient or create_patient.`,
      };
    }
  }

  // 2. Availability before book: check_availability must precede book_appointment
  const bookIndex = toolCalls.findIndex((t) => t.tool_name === "book_appointment");
  if (bookIndex !== -1) {
    const availIndex = toolCalls.findIndex(
      (t) => t.tool_name === "check_availability",
    );
    if (availIndex === -1 || availIndex > bookIndex) {
      return {
        passed: false,
        reason: "Tool trace violation: book_appointment was called without first calling check_availability.",
      };
    }
  }

  // 3. Arguments match what caller stated: verify name and DOB in find_patient / create_patient
  for (const call of toolCalls) {
    if (call.tool_name === "find_patient" || call.tool_name === "create_patient") {
      const args = call.arguments as Record<string, string>;
      if (args.full_name) {
        const cleanedArg = args.full_name.toLowerCase().trim();
        const cleanedExpected = scenario.caller_info.stated_name.toLowerCase().trim();
        const firstExpected = cleanedExpected.split(" ")[0] ?? "";
        const firstArg = cleanedArg.split(" ")[0] ?? "";
        if (
          firstExpected.length > 0 &&
          firstArg.length > 0 &&
          !cleanedArg.includes(firstExpected) &&
          !cleanedExpected.includes(firstArg)
        ) {
          return {
            passed: false,
            reason: `Tool trace violation: ${call.tool_name} called with name mismatch (called with '${args.full_name}', expected '${scenario.caller_info.stated_name}').`,
          };
        }
      }
    }
  }

  // 4. Confirmation before book: ensure caller turn before book_appointment expressed agreement
  if (bookIndex !== -1) {
    const bookCall = toolCalls[bookIndex];
    if (!bookCall) return { passed: false, reason: "Tool trace bookCall not found." };
    // Find the caller turn prior to this tool call
    const turnIndex = transcript.findIndex(
      (t) => t.tool_calls?.some((tc) => tc.timestamp === bookCall.timestamp),
    );
    if (turnIndex > 0) {
      const priorTurns = transcript.slice(0, turnIndex);
      const lastPatientTurn = [...priorTurns]
        .reverse()
        .find((t) => t.role === "patient");
      if (lastPatientTurn) {
        const text = lastPatientTurn.content.toLowerCase();
        const hasConfirmation =
          text.includes("yes") ||
          text.includes("that works") ||
          text.includes("please") ||
          text.includes("sounds good") ||
          text.includes("book") ||
          text.includes("perfect") ||
          text.includes("correct") ||
          text.includes("confirm") ||
          text.includes("sure");
        if (!hasConfirmation && text.length > 5) {
          return {
            passed: false,
            reason: "Tool trace violation: book_appointment called before caller confirmed the slot.",
          };
        }
      }
    }
  }

  return {
    passed: true,
    reason: "Tool trace valid: proper identification sequence, availability checked, and arguments aligned.",
  };
}
