-- Creates the complete Phase 1 clinic schema and its database-enforced invariants.
-- PostgreSQL, not application timing, remains the authority on double-booking.

-- UUID generation is built into modern Postgres; btree_gist lets UUID equality share a GiST index with range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE appointment_status AS ENUM ('booked', 'cancelled', 'completed', 'no_show');
CREATE TYPE call_outcome AS ENUM ('in_progress', 'booked', 'rescheduled', 'cancelled', 'no_action', 'failed');
CREATE TYPE calendar_provider AS ENUM ('google', 'cal_com');
CREATE TYPE calendar_sync_status AS ENUM ('not_configured', 'pending', 'synced', 'failed');

CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  specialty text NOT NULL,
  timezone text NOT NULL,
  calendar_provider calendar_provider,
  external_calendar_id text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doctors_calendar_configuration_check
    CHECK ((calendar_provider IS NULL) = (external_calendar_id IS NULL))
);

-- Specialty plus activity is the access path for requests that do not name a doctor.
CREATE INDEX doctors_specialty_active_idx ON doctors (specialty, is_active);

CREATE TABLE availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_duration_minutes integer NOT NULL CHECK (slot_duration_minutes BETWEEN 5 AND 240),
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT availability_rules_time_order_check CHECK (start_time < end_time)
);

-- Slot expansion reads all active rules for one doctor and then groups them by local weekday.
CREATE INDEX availability_rules_doctor_day_idx
  ON availability_rules (doctor_id, day_of_week) WHERE is_active;

CREATE TABLE time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  time_span tstzrange NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_off_valid_range_check
    CHECK (NOT isempty(time_span) AND lower_inc(time_span) AND NOT upper_inc(time_span))
);

-- This multicolumn GiST index narrows range-overlap scans to one doctor before checking time.
CREATE INDEX time_off_doctor_span_gist_idx ON time_off USING gist (doctor_id, time_span);

CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  date_of_birth date NOT NULL,
  phone_e164 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX patients_phone_unique_idx ON patients (phone_e164);

-- Case-folding supports spoken-name lookup while DOB supplies the second verification factor.
CREATE INDEX patients_normalized_name_dob_idx ON patients (lower(full_name), date_of_birth);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  time_span tstzrange NOT NULL,
  status appointment_status NOT NULL DEFAULT 'booked',
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  calendar_sync_status calendar_sync_status NOT NULL DEFAULT 'not_configured',
  external_calendar_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_valid_range_check
    CHECK (NOT isempty(time_span) AND lower_inc(time_span) AND NOT upper_inc(time_span)),
  CONSTRAINT appointments_no_doctor_overlap
    EXCLUDE USING gist (doctor_id WITH =, time_span WITH &&) WHERE (status = 'booked')
);

-- Retries reuse the original result instead of creating a second appointment.
CREATE UNIQUE INDEX appointments_idempotency_key_unique_idx ON appointments (idempotency_key);

-- Patient history is presented newest-first in verification and call workflows.
CREATE INDEX appointments_patient_created_idx ON appointments (patient_id, created_at DESC);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retell_call_id text NOT NULL,
  patient_id uuid REFERENCES patients(id),
  outcome call_outcome NOT NULL DEFAULT 'in_progress',
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  total_latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calls_latency_check CHECK (total_latency_ms IS NULL OR total_latency_ms >= 0),
  CONSTRAINT calls_time_order_check CHECK (ended_at IS NULL OR started_at <= ended_at)
);

CREATE UNIQUE INDEX calls_retell_call_id_unique_idx ON calls (retell_call_id);

-- Operations screens sort calls by start time, so the index follows that exact read path.
CREATE INDEX calls_started_at_idx ON calls (started_at DESC);

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  tool_name text NOT NULL,
  arguments jsonb NOT NULL,
  result jsonb,
  succeeded boolean NOT NULL,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The timeline view fetches tools for one call in execution order.
CREATE INDEX tool_calls_call_created_idx ON tool_calls (call_id, created_at);
