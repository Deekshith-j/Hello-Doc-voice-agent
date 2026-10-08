// Describes how voice calls and their tool activity are recorded for operators and audits.
// The shapes are provider-neutral; the Retell adapter translates webhook payloads into them.
import type { ToolResponse } from "./tool-response";

export interface TranscriptTurn {
  offsetSeconds: number | null;
  speaker: "agent" | "caller";
  text: string;
}

export interface ToolCallRecord {
  arguments: unknown;
  latencyMs: number;
  providerCallId: string;
  requestId: string;
  result: ToolResponse;
  toolName: string;
  // Set when this tool verified the caller, linking the call to a patient record.
  verifiedPatientId: string | null;
}

export interface CallStartedEvent {
  agentId: string | null;
  callType: string | null;
  providerCallId: string;
  startedAt: Date;
}

export interface CallEndedEvent extends CallStartedEvent {
  disconnectionReason: string | null;
  e2eLatencyP50Ms: number | null;
  endedAt: Date;
  transcript: TranscriptTurn[];
}

export interface CallAnalyzedEvent {
  providerCallId: string;
  summary: string | null;
}

export interface CallLogRepository {
  recordCallAnalyzed(event: CallAnalyzedEvent): Promise<void>;
  recordCallEnded(event: CallEndedEvent): Promise<void>;
  recordCallStarted(event: CallStartedEvent): Promise<void>;
  recordToolCall(record: ToolCallRecord): Promise<void>;
}
