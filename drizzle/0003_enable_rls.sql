-- Enables Row Level Security (RLS) on all application tables with zero policies.
-- Our backend connects exclusively as the 'postgres' superuser/owner role via server-side SQL,
-- which bypasses RLS by default.
-- Enabling RLS without policies blocks Supabase's public API roles (anon and authenticated)
-- from querying or modifying these tables through PostgREST / supabase-js client APIs.

ALTER TABLE doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
