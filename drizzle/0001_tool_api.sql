-- Adds the durable counters and request identity needed by production tool routes.
-- These records are operational metadata and intentionally contain no patient payloads.

CREATE TABLE rate_limit_buckets (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (key, window_start)
);

-- Request IDs make duplicated webhook/tool deliveries observable and impossible to store twice.
CREATE UNIQUE INDEX tool_calls_request_id_unique_idx ON tool_calls (request_id);
