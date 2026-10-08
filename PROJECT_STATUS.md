<!-- Gives another coding agent a fast, factual handoff without replaying the full conversation. -->
<!-- Update this file whenever a phase starts, completes, or changes a project-level assumption. -->

# Docto project status

## Current phase

Phase 6 / Launch Readiness complete. Application, APIs, Retell integration layer, full responsive UI dashboard across all pages, evaluation harness, CI, and deployment configuration (`vercel.json`) are built and verified with zero errors.

## Completed

- **Phase 1: Domain & Schema**: Pure timezone-aware availability engine (`getFreeSlots`), Postgres GiST range exclusion constraints preventing double bookings, Drizzle schema, migrations 0000–0002, synthetic seeds, and embedded PostgreSQL test harness.
- **Phase 2: Tool Endpoints & Services**: Zod-validated tool routes (`list-doctors`, `find-patient`, `check-availability`, `book-appointment`, `list-patient-appointments`, `reschedule-appointment`, `cancel-appointment`), PostgreSQL rate limiting, Google Calendar free/busy + idempotent upsert, and `/api/internal/calendar-sync` retry endpoint.
- **Phase 3: Retell AI Engine**: Retell agent provisioning (`npm run retell:setup`), system prompt with clinic policies, function tool schemas, HMAC webhook signature verification, web call access token route (`/api/retell/web-call`), and call activity polling endpoint.
- **Phase 4: Full Responsive UI**: Restrained clinic front-desk workspace matching design system:
  - Sign-in page with constant-time passphrase verification and session cookie (`/login`).
  - Live call workspace with Retell browser WebRTC integration, voice activity indicators, live transcript stream, and audited tool activity (`/`).
  - Calls history with flagged attention items (sync failures & dropped calls) and latency percentiles (`/calls`).
  - Deep-linkable call detail audit screen (`/calls/[id]`).
  - Provider agenda view across all doctors with sync statuses (`/appointments`).
  - Doctors & weekly availability rules with calendar integration badges (`/doctors`).
  - Evaluations test benchmark viewer (`/evaluations`).
- **Phase 5: Evaluation Harness**: Automated test suite simulating multi-turn scheduling, double-booking rejection, patient verification, and date arithmetic (`npm run eval`).
- **Phase 6 & 7: Production Prep**: Production `README.md`, `.github/workflows/ci.yml`, `vercel.json` with 10-minute calendar reconciliation cron job, and formatted code base.

## Quality Commands

All commands verified passing:

```bash
npm run typecheck      # Next.js route typegen + tsc clean
npm run lint           # ESLint with 0 warnings
npm run format:check   # Prettier format check
npm test               # 65 passing wire-protocol database tests
npm run build          # Production Next.js build
```

## User Configuration Steps for Launch

1. **Supabase Database URL**: Add your pooled Supabase Postgres URL to `DATABASE_URL` in `.env.local` / Vercel. Run `npm run db:migrate` and `npm run db:seed`.
2. **Retell AI**: Add `RETELL_API_KEY` and run `npm run retell:setup` to deploy the agent. Set `RETELL_AGENT_ID`.
3. **Google Calendar (Optional)**: Provide OAuth credentials in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
4. **Vercel Deploy**: Deploy repository and set `DASHBOARD_PASSWORD`, `SESSION_SECRET`, and `CRON_SECRET`.
