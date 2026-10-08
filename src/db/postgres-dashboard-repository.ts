// Answers the read-only questions the operator dashboard asks about calls, schedules, and evals.
// Each query returns display-ready rows so pages never assemble SQL results themselves.
import type { Sql } from "postgres";

import type { TranscriptTurn } from "@/application/call-log";
import type { CalendarSyncStatus } from "@/application/clinic-repository";
import type { ToolResponse } from "@/application/tool-response";

export type CallOutcome =
  | "in_progress"
  | "booked"
  | "rescheduled"
  | "cancelled"
  | "no_action"
  | "failed";

export interface CallSummary {
  callType: string | null;
  e2eLatencyP50Ms: number | null;
  endedAt: Date | null;
  failedTools: number;
  id: string;
  outcome: CallOutcome;
  patientName: string | null;
  providerCallId: string;
  startedAt: Date;
  summary: string | null;
  toolCount: number;
}

export interface ToolActivity {
  arguments: unknown;
  createdAt: Date;
  id: string;
  latencyMs: number;
  result: ToolResponse | null;
  succeeded: boolean;
  toolName: string;
}

export interface CallDetail extends CallSummary {
  disconnectionReason: string | null;
  tools: ToolActivity[];
  transcript: TranscriptTurn[];
}

export interface AgendaAppointment {
  calendarSyncStatus: CalendarSyncStatus;
  doctorId: string;
  doctorName: string;
  doctorTimezone: string;
  endAt: Date;
  id: string;
  patientName: string;
  reason: string;
  startAt: Date;
  status: "booked" | "cancelled" | "completed" | "no_show";
}

export interface DoctorSchedule {
  bookedNextWeek: number;
  calendarConnected: boolean;
  fullName: string;
  id: string;
  rules: { dayOfWeek: number; endTime: string; startTime: string }[];
  slotMinutes: number | null;
  specialty: string;
  timeOff: { endAt: Date; reason: string | null; startAt: Date }[];
  timezone: string;
}

export interface AttentionItem {
  detail: string;
  href: string;
  id: string;
  kind: "calendar_sync" | "failed_call";
  occurredAt: Date;
}

export interface EvalRunSummary {
  failed: number;
  finishedAt: Date;
  id: string;
  passed: number;
  results: EvalCaseResult[];
  startedAt: Date;
  suite: string;
}

export interface EvalCaseResult {
  checks: { name: string; passed: boolean; detail: string }[];
  durationMs: number;
  name: string;
  passed: boolean;
}

interface CallRow {
  call_type: string | null;
  e2e_latency_p50_ms: number | null;
  ended_at: Date | null;
  failed_tools: number;
  id: string;
  outcome: CallOutcome;
  patient_name: string | null;
  retell_call_id: string;
  started_at: Date;
  summary: string | null;
  tool_count: number;
}

export class PostgresDashboardRepository {
  constructor(private readonly sql: Sql) {}

  async listCalls(limit: number): Promise<CallSummary[]> {
    // The started_at index serves the newest-first scan; tool counts aggregate per call.
    const rows = await this.sql<CallRow[]>`
      SELECT ${callColumns(this.sql)}
      FROM calls c
      LEFT JOIN patients p ON p.id = c.patient_id
      ORDER BY c.started_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toCallSummary);
  }

  async getCall(id: string): Promise<CallDetail | null> {
    const rows = await this.sql<
      (CallRow & {
        disconnection_reason: string | null;
        transcript: TranscriptTurn[];
      })[]
    >`
      SELECT ${callColumns(this.sql)}, c.disconnection_reason, c.transcript
      FROM calls c
      LEFT JOIN patients p ON p.id = c.patient_id
      WHERE c.id = ${id}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      ...toCallSummary(row),
      disconnectionReason: row.disconnection_reason,
      transcript: row.transcript,
      tools: await this.listToolActivity(row.id),
    };
  }

  async getLiveActivity(providerCallId: string): Promise<{
    outcome: CallOutcome;
    patientName: string | null;
    tools: ToolActivity[];
  } | null> {
    // Polled during a live web call, so it reads one call by its unique provider ID.
    const rows = await this.sql<CallRow[]>`
      SELECT ${callColumns(this.sql)}
      FROM calls c
      LEFT JOIN patients p ON p.id = c.patient_id
      WHERE c.retell_call_id = ${providerCallId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      outcome: row.outcome,
      patientName: row.patient_name,
      tools: await this.listToolActivity(row.id),
    };
  }

  async listAgenda(from: Date, to: Date): Promise<AgendaAppointment[]> {
    // The time_span GiST index answers this overlap across every doctor.
    const rows = await this.sql<
      {
        calendar_sync_status: CalendarSyncStatus;
        doctor_id: string;
        doctor_name: string;
        doctor_timezone: string;
        end_at: Date;
        id: string;
        patient_name: string;
        reason: string;
        start_at: Date;
        status: AgendaAppointment["status"];
      }[]
    >`
      SELECT a.id, a.doctor_id, d.full_name AS doctor_name, d.timezone AS doctor_timezone,
        p.full_name AS patient_name, a.reason, a.status, a.calendar_sync_status,
        lower(a.time_span) AS start_at, upper(a.time_span) AS end_at
      FROM appointments a
      JOIN doctors d ON d.id = a.doctor_id
      JOIN patients p ON p.id = a.patient_id
      WHERE a.time_span && tstzrange(${from}, ${to}, '[)')
      ORDER BY lower(a.time_span), d.full_name
    `;
    return rows.map((row) => ({
      id: row.id,
      doctorId: row.doctor_id,
      doctorName: row.doctor_name,
      doctorTimezone: row.doctor_timezone,
      patientName: row.patient_name,
      reason: row.reason,
      status: row.status,
      calendarSyncStatus: row.calendar_sync_status,
      startAt: new Date(row.start_at),
      endAt: new Date(row.end_at),
    }));
  }

  async listDoctorSchedules(now: Date): Promise<DoctorSchedule[]> {
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
    const [doctors, rules, timeOff] = await Promise.all([
      this.sql<
        {
          booked_next_week: number;
          external_calendar_id: string | null;
          full_name: string;
          id: string;
          specialty: string;
          timezone: string;
        }[]
      >`
        SELECT d.id, d.full_name, d.specialty, d.timezone, d.external_calendar_id,
          (SELECT count(*)::int FROM appointments a
            WHERE a.doctor_id = d.id AND a.status = 'booked'
              AND a.time_span && tstzrange(${now}, ${weekAhead}, '[)')) AS booked_next_week
        FROM doctors d WHERE d.is_active = true
        ORDER BY d.specialty, d.full_name
      `,
      this.sql<
        {
          day_of_week: number;
          doctor_id: string;
          end_time: string;
          slot_duration_minutes: number;
          start_time: string;
        }[]
      >`
        SELECT doctor_id, day_of_week, start_time::text, end_time::text, slot_duration_minutes
        FROM availability_rules WHERE is_active = true
        ORDER BY doctor_id, day_of_week, start_time
      `,
      this.sql<
        {
          doctor_id: string;
          end_at: Date;
          reason: string | null;
          start_at: Date;
        }[]
      >`
        SELECT doctor_id, lower(time_span) AS start_at, upper(time_span) AS end_at, reason
        FROM time_off
        WHERE upper(time_span) > ${now}
        ORDER BY lower(time_span)
      `,
    ]);
    return doctors.map((doctor) => {
      const own = rules.filter((rule) => rule.doctor_id === doctor.id);
      return {
        id: doctor.id,
        fullName: doctor.full_name,
        specialty: doctor.specialty,
        timezone: doctor.timezone,
        calendarConnected: doctor.external_calendar_id !== null,
        bookedNextWeek: doctor.booked_next_week,
        slotMinutes: own[0]?.slot_duration_minutes ?? null,
        rules: own.map((rule) => ({
          dayOfWeek: rule.day_of_week,
          startTime: rule.start_time.slice(0, 5),
          endTime: rule.end_time.slice(0, 5),
        })),
        timeOff: timeOff
          .filter((entry) => entry.doctor_id === doctor.id)
          .map((entry) => ({
            startAt: new Date(entry.start_at),
            endAt: new Date(entry.end_at),
            reason: entry.reason,
          })),
      };
    });
  }

  async listAttentionItems(limit: number): Promise<AttentionItem[]> {
    // Only things a person must act on: calendar writes that keep failing and calls that errored.
    const rows = await this.sql<
      {
        detail: string;
        id: string;
        kind: AttentionItem["kind"];
        occurred_at: Date;
      }[]
    >`
      (
        SELECT a.id, 'calendar_sync' AS kind, a.updated_at AS occurred_at,
          d.full_name || ' calendar not updated for ' || p.full_name AS detail
        FROM appointments a
        JOIN doctors d ON d.id = a.doctor_id
        JOIN patients p ON p.id = a.patient_id
        WHERE a.calendar_sync_status = 'failed'
      )
      UNION ALL
      (
        SELECT c.id, 'failed_call' AS kind, c.started_at AS occurred_at,
          'Call ended with ' || COALESCE(replace(c.disconnection_reason, '_', ' '), 'an error') AS detail
        FROM calls c
        WHERE c.outcome = 'failed' AND c.started_at > now() - interval '7 days'
      )
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      occurredAt: new Date(row.occurred_at),
      detail: row.detail,
      href: row.kind === "failed_call" ? `/calls/${row.id}` : "/appointments",
    }));
  }

  async listEvalRuns(limit: number): Promise<EvalRunSummary[]> {
    const rows = await this.sql<
      {
        failed: number;
        finished_at: Date;
        id: string;
        passed: number;
        results: EvalCaseResult[];
        started_at: Date;
        suite: string;
      }[]
    >`
      SELECT id, suite, started_at, finished_at, passed, failed, results
      FROM eval_runs ORDER BY started_at DESC LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      suite: row.suite,
      startedAt: new Date(row.started_at),
      finishedAt: new Date(row.finished_at),
      passed: row.passed,
      failed: row.failed,
      results: row.results,
    }));
  }

  async saveEvalRun(run: Omit<EvalRunSummary, "id">): Promise<void> {
    await this.sql`
      INSERT INTO eval_runs (suite, started_at, finished_at, passed, failed, results)
      VALUES (${run.suite}, ${run.startedAt}, ${run.finishedAt}, ${run.passed}, ${run.failed},
        ${this.sql.json(run.results as never)})
    `;
  }

  private async listToolActivity(callId: string): Promise<ToolActivity[]> {
    // The (call_id, created_at) index returns tools in execution order.
    const rows = await this.sql<
      {
        arguments: unknown;
        created_at: Date;
        id: string;
        latency_ms: number;
        result: ToolResponse | null;
        succeeded: boolean;
        tool_name: string;
      }[]
    >`
      SELECT id, tool_name, arguments, result, succeeded, latency_ms, created_at
      FROM tool_calls WHERE call_id = ${callId}
      ORDER BY created_at
    `;
    return rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      arguments: row.arguments,
      result: row.result,
      succeeded: row.succeeded,
      latencyMs: row.latency_ms,
      createdAt: row.created_at,
    }));
  }
}

function callColumns(sql: Sql) {
  return sql`c.id, c.retell_call_id, c.started_at, c.ended_at, c.outcome, c.call_type,
    c.summary, c.e2e_latency_p50_ms, p.full_name AS patient_name,
    (SELECT count(*)::int FROM tool_calls t WHERE t.call_id = c.id) AS tool_count,
    (SELECT count(*)::int FROM tool_calls t WHERE t.call_id = c.id AND NOT t.succeeded) AS failed_tools`;
}

function toCallSummary(row: CallRow): CallSummary {
  return {
    id: row.id,
    providerCallId: row.retell_call_id,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
    outcome: row.outcome,
    callType: row.call_type,
    summary: row.summary,
    e2eLatencyP50Ms: row.e2e_latency_p50_ms,
    patientName: row.patient_name,
    toolCount: row.tool_count,
    failedTools: row.failed_tools,
  };
}
