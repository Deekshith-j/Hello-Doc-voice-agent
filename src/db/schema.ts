// Declares the clinic's Postgres schema as the shared contract for application code.
// Database-only invariants such as range exclusion are added in the SQL migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestampRange = customType<{ data: string }>({
  dataType() {
    return "tstzrange";
  },
});

export const appointmentStatus = pgEnum("appointment_status", [
  "booked",
  "cancelled",
  "completed",
  "no_show",
]);

export const callOutcome = pgEnum("call_outcome", [
  "in_progress",
  "booked",
  "rescheduled",
  "cancelled",
  "no_action",
  "failed",
]);

export const calendarProvider = pgEnum("calendar_provider", [
  "google",
  "cal_com",
]);

export const calendarSyncStatus = pgEnum("calendar_sync_status", [
  "not_configured",
  "pending",
  "synced",
  "failed",
]);

export const doctors = pgTable(
  "doctors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    specialty: text("specialty").notNull(),
    timezone: text("timezone").notNull(),
    calendarProvider: calendarProvider("calendar_provider"),
    externalCalendarId: text("external_calendar_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("doctors_specialty_active_idx").on(table.specialty, table.isActive),
    check(
      "doctors_calendar_configuration_check",
      sql`(${table.calendarProvider} IS NULL) = (${table.externalCalendarId} IS NULL)`,
    ),
  ],
);

export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => doctors.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull(),
    startTime: time("start_time", { withTimezone: false }).notNull(),
    endTime: time("end_time", { withTimezone: false }).notNull(),
    slotDurationMinutes: integer("slot_duration_minutes").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    index("availability_rules_doctor_day_idx")
      .on(table.doctorId, table.dayOfWeek)
      .where(sql`${table.isActive} = true`),
    check(
      "availability_rules_day_check",
      sql`${table.dayOfWeek} BETWEEN 0 AND 6`,
    ),
    check(
      "availability_rules_time_order_check",
      sql`${table.startTime} < ${table.endTime}`,
    ),
    check(
      "availability_rules_duration_check",
      sql`${table.slotDurationMinutes} BETWEEN 5 AND 240`,
    ),
  ],
);

export const timeOff = pgTable(
  "time_off",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => doctors.id, { onDelete: "cascade" }),
    timeSpan: timestampRange("time_span").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("time_off_doctor_span_gist_idx").using(
      "gist",
      table.doctorId,
      table.timeSpan,
    ),
    check(
      "time_off_valid_range_check",
      sql`NOT isempty(${table.timeSpan}) AND lower_inc(${table.timeSpan}) AND NOT upper_inc(${table.timeSpan})`,
    ),
  ],
);

export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }).notNull(),
    phoneE164: text("phone_e164").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("patients_phone_unique_idx").on(table.phoneE164),
    index("patients_normalized_name_dob_idx").on(
      sql`lower(${table.fullName})`,
      table.dateOfBirth,
    ),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => doctors.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    timeSpan: timestampRange("time_span").notNull(),
    status: appointmentStatus("status").notNull().default("booked"),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    calendarSyncStatus: calendarSyncStatus("calendar_sync_status")
      .notNull()
      .default("not_configured"),
    externalCalendarEventId: text("external_calendar_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("appointments_idempotency_key_unique_idx").on(
      table.idempotencyKey,
    ),
    index("appointments_patient_created_idx").on(
      table.patientId,
      table.createdAt.desc(),
    ),
    index("appointments_time_span_gist_idx").using("gist", table.timeSpan),
    index("appointments_patient_booked_idx")
      .on(table.patientId)
      .where(sql`${table.status} = 'booked'`),
    check(
      "appointments_valid_range_check",
      sql`NOT isempty(${table.timeSpan}) AND lower_inc(${table.timeSpan}) AND NOT upper_inc(${table.timeSpan})`,
    ),
  ],
);

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    retellCallId: text("retell_call_id").notNull(),
    patientId: uuid("patient_id").references(() => patients.id),
    outcome: callOutcome("outcome").notNull().default("in_progress"),
    transcript: jsonb("transcript").notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    e2eLatencyP50Ms: integer("e2e_latency_p50_ms"),
    agentId: text("agent_id"),
    callType: text("call_type"),
    disconnectionReason: text("disconnection_reason"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("calls_retell_call_id_unique_idx").on(table.retellCallId),
    index("calls_started_at_idx").on(table.startedAt.desc()),
    check(
      "calls_e2e_latency_check",
      sql`${table.e2eLatencyP50Ms} IS NULL OR ${table.e2eLatencyP50Ms} >= 0`,
    ),
    check(
      "calls_time_order_check",
      sql`${table.endedAt} IS NULL OR ${table.startedAt} <= ${table.endedAt}`,
    ),
  ],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments").notNull(),
    result: jsonb("result"),
    succeeded: boolean("succeeded").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tool_calls_call_created_idx").on(table.callId, table.createdAt),
    uniqueIndex("tool_calls_request_id_unique_idx").on(table.requestId),
    check("tool_calls_latency_check", sql`${table.latencyMs} >= 0`),
  ],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    check("rate_limit_buckets_count_check", sql`${table.requestCount} > 0`),
  ],
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suite: text("suite").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    passed: integer("passed").notNull(),
    failed: integer("failed").notNull(),
    results: jsonb("results").notNull(),
  },
  (table) => [index("eval_runs_started_at_idx").on(table.startedAt.desc())],
);

export type Doctor = typeof doctors.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type NewPatient = typeof patients.$inferInsert;
