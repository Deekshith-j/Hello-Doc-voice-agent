# Agent Rules & Architecture Directives

These rules govern all architectural, implementation, evaluation, and operational decisions for this project.

## 1. Database: Supabase (replaces Neon)
- **Engine & Access**: Postgres on Supabase, accessed ONLY from the server via Drizzle ORM and `postgres.js`.
- **Runtime Pooler**: Runtime uses `DATABASE_URL` (Supabase transaction pooler, port 6543) with `prepare: false`. Always maintain a comment in the client file explaining why (`prepare: false` is required because the transaction pooler does not support prepared statements).
- **Direct Migrations**: Migrations (`drizzle-kit`) use `DIRECT_URL` (direct connection to Postgres on port 5432).
- **btree_gist Extension**: The first migration runs `CREATE EXTENSION IF NOT EXISTS btree_gist` before the `EXCLUDE` constraint.
- **Row Level Security**: Enable RLS with no policies on every table.
- **Explicit SQL**: Do NOT use Supabase Auth or the `supabase-js` query client. Keep SQL explicit via server-side Drizzle/postgres.js.
- **Secrets Security**: Never put the service-role key or DB password in client code or any `NEXT_PUBLIC_` variable.
- **Evaluation Isolation**: Evals run against a SEPARATE Supabase project (or local `supabase start`), with a reset script that truncates tables and reseeds before each run. Include `TEST_DATABASE_URL` in `.env.example`.
- **Documentation**: `DECISIONS.md` must explain the pooler vs direct connection choice.

## 2. Retell Budget & Call Constraints (Free Credit Guardrails)
- **Credit Limit**: Total free credit is ~$10 (~75 minutes).
- **Text-Only Evals**: Evals must run in TEXT mode using your own LLM key. Never use Retell voice minutes for automated evals.
- **Evidence-Only Voice Calls**: Real voice/web calls are reserved strictly for evidence: plan for approximately 10–15 short calls only.
- **Web Calls Only**: Use web calls exclusively. Do not buy, claim, or configure a phone number.
- **Cost-Effective LLM**: Keep the agent on a cheaper LLM. Do not choose a premium model.
- **Permission Required**: Do NOT run any Retell call or paid API request without explicit confirmation from the user first.

## 3. Setup Order
- **Backend First**: The Retell agent prompt and custom functions require a public URL, so the execution order must strictly be:
  1. Database schema and slot engine logic
  2. API tools
  3. Deploy to Vercel
  4. Retell prompt, functions, and webhook integration
- **No Premature Assumptions**: Do not write instructions or code that assumes the Retell agent is configured until the backend API is deployed and live.

## 4. Free-Tier Caution
- **Inactive Project Pause**: Supabase free-tier projects can pause when inactive. Maintain a note in `RUNBOOK.md` to open the Supabase dashboard project the day before any demo or interview to ensure it is awake.
