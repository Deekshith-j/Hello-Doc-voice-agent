# Docto

## 1. What It Is

Docto is an AI voice receptionist for clinical appointment scheduling. It handles patient lookup, availability checks, bookings, rescheduling, and cancellations over telephone calls and browser audio. The backend uses PostgreSQL exclusion constraints to prevent double-booking and synchronizes appointments with external calendars.

Live demo: [https://docto-agent.vercel.app](https://docto-agent.vercel.app)

![Docto Live Call Workspace](docs/images/dashboard.png)

---

## 2. How It Works

```text
  Caller (Phone / Web)
          │  Audio
          ▼
    Retell AI Voice Engine
          │  Signed HTTP Tool Calls
          ▼
   Next.js Tool API Routes (/api/tools/*)
     ├── PostgreSQL (Supabase) ── GiST Exclusion Constraint & Idempotency
     └── Google Calendar API   ── Inline Free/Busy & Background Sync
```

1. A caller initiates a conversation via phone or browser web audio.
2. Retell voice agent collects the caller's full name and date of birth, invoking `/api/tools/find-patient`.
3. The agent queries open schedule intervals through `/api/tools/check-availability` for the requested doctor and date.
4. The caller selects an offered time slot, and the agent calls `/api/tools/book-appointment`.
5. The API route derives an idempotency key and commits the booking in PostgreSQL, guarded by a GiST exclusion constraint against double-booking.
6. The booking confirmation returns to the agent to speak to the caller, while Google Calendar sync runs inline with a timeout and queues for background retry on failure.

---

## 3. Tech Stack

| Layer                | Tool                                 | Reason                                                                                      |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Runtime & Framework  | Next.js 16 (App Router) / Node.js 24 | Unified full-stack serverless API routes, server actions, and dashboard UI.                 |
| Language             | TypeScript                           | Strict static type safety across database schemas, tool definitions, and application code.  |
| Database & ORM       | PostgreSQL (Supabase) / Drizzle ORM  | Relational persistence with btree_gist exclusion constraints for race-condition prevention. |
| Voice Telephony      | Retell AI                            | Real-time conversational voice streaming, speech-to-text, and audio turn-taking.            |
| UI & Styling         | Tailwind CSS                         | Responsive styling for the clinical operations console.                                     |
| Test Runner          | Vitest                               | Fast test execution with isolated transaction support.                                      |
| Calendar Integration | Google Calendar API                  | External calendar free/busy lookup and event synchronization.                               |
| Evaluation LLMs      | Google Gemini API                    | Automated multi-turn patient dialogue simulation and rubric evaluation.                     |

---

## 4. Project Structure

```text
.github/      GitHub Actions CI workflows and scheduled tasks
docs/         Architecture, walkthrough, engineering decisions, and design Q&A
drizzle/      PostgreSQL migrations and schema tracking
evals/        Tool API regression suite and multi-turn agent evaluation harness
src/          Next.js application source code, API routes, domain logic, and repositories
tests/        Unit, concurrency, and integration test suites
```

---

## 5. Setup

### Prerequisites

- Node.js 24+
- npm 10+
- A PostgreSQL database instance (such as Supabase) with the `btree_gist` extension available

### Environment Variables

Configure the following variables in `.env.local`:

- `DATABASE_URL`: Transaction pooler connection string (port 6543) for runtime queries, configured with `prepare: false`.
- `DIRECT_URL`: Direct PostgreSQL connection string (port 5432) for migrations and DDL operations.
- `TEST_DATABASE_URL`: Isolated PostgreSQL database URL for running the test suite and evaluation harnesses.
- `RETELL_API_KEY`: Retell AI API secret key for agent provisioning and webhook signature verification.
- `RETELL_AGENT_ID`: Provisioned Retell voice agent identifier.
- `PUBLIC_BASE_URL`: Public HTTPS base URL registered with Retell for webhooks and tool routes.
- `CRON_SECRET`: Bearer authentication token protecting the internal calendar synchronization endpoint.
- `GOOGLE_CLIENT_ID`: OAuth2 client ID for Google Calendar API integration.
- `GOOGLE_CLIENT_SECRET`: OAuth2 client secret for Google Calendar API integration.
- `GOOGLE_REFRESH_TOKEN`: Offline OAuth2 refresh token for Google Calendar API access.
- `LLM_API_KEY`: Google Gemini API key used by the simulated evaluation harness.
- `WEB_CALLS_ENABLED`: Feature flag (`true` or `false`) controlling browser web-call access on `/api/retell/web-call`.

### Installation and Initialization

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Run database migrations:

   ```bash
   npm run migrate
   ```

3. Seed synthetic clinic data:

   ```bash
   npm run seed
   ```

4. Provision the Retell agent prompt and tools:

   ```bash
   npm run agent:provision
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

---

## 6. Commands

- `npm run typecheck`: Runs `next typegen && tsc --noEmit` to verify TypeScript types.
- `npm run lint`: Runs ESLint with zero warnings allowed.
- `npm test`: Runs the Vitest test suite (103 tests across 13 test files).
- `npm run eval`: Runs the 14-scenario tool API regression suite against the test database.
- `npm run eval:agent`: Runs the multi-turn agent evaluation harness with simulated patient and judge.
- `npm run build`: Generates the production Next.js build using Turbopack.

---

## 7. Testing and Evaluation

The repository contains two distinct verification layers:

1. **Unit and Integration Suite (Vitest)**: 103 tests across 13 test files.
   - Measures pure slot math across daylight saving cutovers, partial overlaps, doctor working hours, and time off.
   - Verifies PostgreSQL GiST exclusion constraint concurrency under racing parallel bookings.
   - Validates server-derived idempotency key hashing, cancellation revival, sliding-window rate limiting, and tool route error sanitization.

2. **Evaluation Layer (`evals/`)**:
   - **Tool API Regression Suite** (`evals/tool-api-suite/`): 14 deterministic scenarios validating tool endpoint HTTP response contracts and database states.
   - **Multi-Turn Agent Evaluation Harness** (`evals/agent-eval/`): Simulates dynamic patient conversations against the system prompt, measuring tool call sequencing, database post-conditions, and LLM judge rubrics (bedside manner, medical safety).

### Evaluation Results

Results from `evals/results/agent-eval-smoke-1791833840065.json`:

- **Suite Mode**: 5-scenario smoke test (`book-exist-01`, `book-exist-02`, `reg-new-01`, `reg-new-02`, `resched-01`), repetitions `N=1`.
- **Pass Rate**: 4 of 5 runs passed (80.0% overall pass rate).
  - `book_existing_patient`: 1 / 2 passed (50.0%)
  - `register_new_patient_then_book`: 2 / 2 passed (100.0%)
  - `reschedule`: 1 / 1 passed (100.0%)
- **Database Invariant Satisfaction**: 5 of 5 runs satisfied (100.0%).
- **Tokens and Cost**: 397,036 total tokens, $0.0204 USD total cost (within the $2.00 hard budget cap).
- **Latency**: Median LLM turn latency of 957 ms.

### Evaluation Models

- **Agent Model**: `gemini-flash-lite-latest`
- **Patient Model**: `gemini-3.5-flash-lite`
- **Judge Model**: `gemini-3.1-flash-lite`
- **Deployed Retell Model**: `gpt-6-luna`

_Note_: The evaluation harness agent runs in text mode using `gemini-flash-lite-latest` for low-cost automated testing. The production voice agent deployed on Retell uses `gpt-6-luna` with voice streaming and turn-taking.

---

## 8. Key Design Decisions

- **Exclusion constraint**: PostgreSQL partial GiST exclusion constraint (`appointments_no_doctor_overlap`) on `(doctor_id WITH =, time_span WITH &&) WHERE (status = 'booked')` using `btree_gist`. Overlapping bookings for the same doctor fail at the database engine level with SQLSTATE `23P01`, preventing double-booking during concurrent caller races.
- **Server-derived idempotency key**: Idempotency keys are computed server-side from `sha256(call_id:patient_id:doctor_id:start_time)` rather than client-supplied strings. If an identical booking is attempted repeatedly within the same call session, the existing record is returned. A cancelled appointment re-booked in the same session revives the record in place.
- **Timezone and daylight saving handling**: Doctor hours are stored in local clinic timezones (`America/New_York`). `getFreeSlots` expands weekly recurring rules into UTC intervals while accounting for 23-hour and 25-hour daylight saving transition days, validating offsets before database queries.
- **Pooler vs direct connection with prepare:false**: Runtime queries connect to Supabase's transaction pooler on port 6543 with `prepare: false` because transaction poolers multiplex connections and discard prepared statements across transactions. DDL migrations connect directly to PostgreSQL on port 5432 via `DIRECT_URL`.
- **RLS enabled with no policies and access control in code**: Row Level Security is enabled on all PostgreSQL tables to block access through Supabase's public anonymous and authenticated PostgREST roles. The backend connects as the database owner, bypassing RLS, while tenant and patient access boundaries are enforced in application code.
- **Tool route adapter**: `createToolHandler` wraps each tool endpoint with Zod schema validation, HMAC-SHA256 signature verification for Retell requests, sliding-window rate limiting, execution latency tracking, zero-PHI logging, and error redaction.
- **Calendar sync**: Google Calendar event writes are attempted inline with a 4-second timeout during booking and cancellation. If the external calendar write fails or times out, the PostgreSQL transaction is preserved, calendar sync is marked `failed`, and reconciliation is retried in the background via `/api/internal/calendar-sync`.

---

## 9. Known Limitations

- **Calendar write path not verified against a live calendar**: Google Calendar integration is verified with unit tests and mock adapters, but the live OAuth refresh token write path has not been tested against an active production Google Workspace calendar.
- **Synthetic data only**: The seed dataset and dashboard expose synthetic demonstration records only. The application is not HIPAA-certified and must not be used with real protected health information (PHI).
- **Name plus date of birth is weak identity verification**: Patient lookup relies on full name and date of birth without two-factor authentication or cryptographic identity verification.
- **Web-call rate limit is per serverless instance**: Browser web-call rate limiting on `/api/retell/web-call` is tracked in-memory per serverless instance rather than coordinated across instances using a distributed cache such as Redis.
- **Only a small eval run so far**: Exactly 5 smoke scenarios (`book-exist-01`, `book-exist-02`, `reg-new-01`, `reg-new-02`, `resched-01`) at `N=1` have been executed. The full 30-scenario benchmark was deferred due to the free-tier Gemini API 15 RPM request rate limit.
- **Emergency number hardcoded**: The emergency escalation number (`911`) is hardcoded in the agent prompt instructions rather than dynamically localized based on caller telephony metadata or clinic location.
