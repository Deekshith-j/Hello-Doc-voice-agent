-- Extends call records with what Retell reports and stores evaluation runs.
-- Calls can be created by a tool request before Retell's call_started webhook arrives.

ALTER TABLE calls
  ADD COLUMN agent_id text,
  ADD COLUMN call_type text,
  ADD COLUMN disconnection_reason text,
  ADD COLUMN summary text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Retell reports end-to-end latency percentiles; p50 is the honest "typical turn" number.
ALTER TABLE calls RENAME COLUMN total_latency_ms TO e2e_latency_p50_ms;
ALTER TABLE calls RENAME CONSTRAINT calls_latency_check TO calls_e2e_latency_check;

-- The agenda reads every doctor's appointments for a date range.
CREATE INDEX appointments_time_span_gist_idx ON appointments USING gist (time_span);

-- A patient's upcoming appointments are listed during reschedule and cancel requests.
CREATE INDEX appointments_patient_booked_idx ON appointments (patient_id) WHERE status = 'booked';

CREATE TABLE eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  passed integer NOT NULL CHECK (passed >= 0),
  failed integer NOT NULL CHECK (failed >= 0),
  results jsonb NOT NULL,
  CONSTRAINT eval_runs_time_order_check CHECK (started_at <= finished_at)
);

CREATE INDEX eval_runs_started_at_idx ON eval_runs (started_at DESC);
