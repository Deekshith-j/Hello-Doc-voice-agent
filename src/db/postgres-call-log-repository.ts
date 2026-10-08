// Persists call lifecycle events and tool activity reported by the voice provider.
// Every write is an upsert because webhooks retry and can arrive out of order.
import type { Sql } from "postgres";

import type {
  CallAnalyzedEvent,
  CallEndedEvent,
  CallLogRepository,
  CallStartedEvent,
  ToolCallRecord,
} from "@/application/call-log";

export class PostgresCallLogRepository implements CallLogRepository {
  constructor(private readonly sql: Sql) {}

  async recordCallStarted(event: CallStartedEvent): Promise<void> {
    // A tool request may have created the row first; the webhook fills in what it knows.
    await this.sql`
      INSERT INTO calls (retell_call_id, agent_id, call_type, started_at)
      VALUES (${event.providerCallId}, ${event.agentId}, ${event.callType}, ${event.startedAt})
      ON CONFLICT (retell_call_id) DO UPDATE SET
        agent_id = COALESCE(EXCLUDED.agent_id, calls.agent_id),
        call_type = COALESCE(EXCLUDED.call_type, calls.call_type),
        started_at = LEAST(calls.started_at, EXCLUDED.started_at),
        updated_at = now()
    `;
  }

  async recordCallEnded(event: CallEndedEvent): Promise<void> {
    // The outcome comes from the last successful write tool, so it reflects what Postgres holds.
    await this.recordCallStarted(event);
    await this.sql`
      UPDATE calls SET
        ended_at = ${event.endedAt},
        transcript = ${this.sql.json(event.transcript as never)},
        disconnection_reason = ${event.disconnectionReason},
        e2e_latency_p50_ms = ${event.e2eLatencyP50Ms},
        outcome = COALESCE(
          (
            SELECT CASE tc.tool_name
              WHEN 'book_appointment' THEN 'booked'::call_outcome
              WHEN 'reschedule_appointment' THEN 'rescheduled'::call_outcome
              ELSE 'cancelled'::call_outcome
            END
            FROM tool_calls tc
            WHERE tc.call_id = calls.id AND tc.succeeded
              AND tc.tool_name IN ('book_appointment', 'reschedule_appointment', 'cancel_appointment')
            ORDER BY tc.created_at DESC
            LIMIT 1
          ),
          CASE WHEN ${event.disconnectionReason ?? ""} LIKE 'error%'
            THEN 'failed'::call_outcome ELSE 'no_action'::call_outcome END
        ),
        updated_at = now()
      WHERE retell_call_id = ${event.providerCallId}
    `;
  }

  async recordCallAnalyzed(event: CallAnalyzedEvent): Promise<void> {
    await this.sql`
      UPDATE calls SET summary = ${event.summary}, updated_at = now()
      WHERE retell_call_id = ${event.providerCallId}
    `;
  }

  async recordToolCall(record: ToolCallRecord): Promise<void> {
    // One statement creates the call if needed, links a verified patient, and logs the tool.
    await this.sql`
      WITH call AS (
        INSERT INTO calls (retell_call_id, started_at, patient_id)
        VALUES (${record.providerCallId}, now(), ${record.verifiedPatientId})
        ON CONFLICT (retell_call_id) DO UPDATE SET
          patient_id = COALESCE(EXCLUDED.patient_id, calls.patient_id),
          updated_at = now()
        RETURNING id
      )
      INSERT INTO tool_calls (call_id, request_id, tool_name, arguments, result, succeeded, latency_ms)
      SELECT call.id, ${record.requestId}, ${record.toolName},
        ${this.sql.json(record.arguments as never)}, ${this.sql.json(record.result as never)},
        ${record.result.ok}, ${record.latencyMs}
      FROM call
      ON CONFLICT (request_id) DO NOTHING
    `;
  }
}
