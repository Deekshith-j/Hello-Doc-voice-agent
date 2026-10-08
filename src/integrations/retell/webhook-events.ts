// Translates Retell webhook payloads into provider-neutral call log events.
// Unknown fields are ignored so Retell can add data without breaking ingestion.
import { z } from "zod";

import type {
  CallAnalyzedEvent,
  CallEndedEvent,
  CallStartedEvent,
  TranscriptTurn,
} from "@/application/call-log";

const utteranceSchema = z.object({
  role: z.string(),
  content: z.string(),
  words: z.array(z.object({ start: z.number().optional() })).optional(),
});

const callSchema = z.object({
  call_id: z.string().min(1),
  agent_id: z.string().optional(),
  call_type: z.string().optional(),
  start_timestamp: z.number().optional(),
  end_timestamp: z.number().optional(),
  disconnection_reason: z.string().optional(),
  transcript_object: z.array(utteranceSchema).optional(),
  latency: z
    .object({ e2e: z.object({ p50: z.number().optional() }).optional() })
    .optional(),
  call_analysis: z.object({ call_summary: z.string().optional() }).optional(),
});

export const retellWebhookSchema = z.object({
  event: z.string(),
  call: callSchema,
});

export type RetellWebhook = z.infer<typeof retellWebhookSchema>;
type RetellCall = RetellWebhook["call"];

export function toCallStarted(call: RetellCall, now: Date): CallStartedEvent {
  return {
    providerCallId: call.call_id,
    agentId: call.agent_id ?? null,
    callType: call.call_type ?? null,
    startedAt: call.start_timestamp ? new Date(call.start_timestamp) : now,
  };
}

export function toCallEnded(call: RetellCall, now: Date): CallEndedEvent {
  const started = toCallStarted(call, now);
  const endedAt = call.end_timestamp ? new Date(call.end_timestamp) : now;
  return {
    ...started,
    // Clock differences must never produce an end before the start.
    endedAt: endedAt < started.startedAt ? started.startedAt : endedAt,
    disconnectionReason: call.disconnection_reason ?? null,
    e2eLatencyP50Ms:
      call.latency?.e2e?.p50 === undefined
        ? null
        : Math.round(call.latency.e2e.p50),
    transcript: toTranscript(call.transcript_object ?? []),
  };
}

export function toCallAnalyzed(call: RetellCall): CallAnalyzedEvent {
  return {
    providerCallId: call.call_id,
    summary: call.call_analysis?.call_summary ?? null,
  };
}

function toTranscript(
  utterances: z.infer<typeof utteranceSchema>[],
): TranscriptTurn[] {
  // Word-level timing is reduced to each turn's start; only operators' needs are stored.
  return utterances
    .filter((turn) => turn.role === "agent" || turn.role === "user")
    .map((turn) => ({
      speaker: turn.role === "agent" ? "agent" : "caller",
      text: turn.content.trim(),
      offsetSeconds: turn.words?.[0]?.start ?? null,
    }));
}
