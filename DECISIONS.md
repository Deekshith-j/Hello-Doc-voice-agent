<!-- Records architectural choices as they are made so interview discussion follows the code's history. -->
<!-- Each phase names rejected alternatives and failure modes instead of presenting choices as inevitable. -->

# Engineering decisions

## Phase 1 — schema, seed, slot calculation, and invariants

### What was built

- A strict Next.js/TypeScript foundation with Drizzle schema definitions for doctors, weekly availability, time off, patients, appointments, calls, and tool calls.
- A tracked PostgreSQL migration that enables `btree_gist`, stores appointment and leave windows as half-open `tstzrange` values, and rejects overlapping booked appointments per doctor.
- A repeatable seed with four synthetic doctors across Family Medicine, Cardiology, Dermatology, and Pediatrics, realistic weekly hours, planned leave, and two synthetic patients.
- A pure `getFreeSlots` domain function. It expands local weekly rules into UTC instants, then subtracts leave, appointments, and external-calendar busy intervals.
- A repository-backed availability service and an `AvailabilitySource` boundary for the later Google Calendar or Cal.com adapter.
- Nine tests covering DST offset changes, nonexistent DST times, partial overlap, leave, the final slot of a day, past slots, external busy time, concurrent double-booking, and idempotent retries.

### Why these choices

Postgres is the booking authority. Availability checks improve the caller experience, but they cannot prevent two calls from racing after both observe a free slot. The partial GiST exclusion constraint applies only to `booked` appointments, so cancellation immediately releases a slot while the database still serializes competing bookings with SQLSTATE `23P01`.

Drizzle owns the typed application schema and query mapping, while the initial migration is reviewed SQL. Drizzle Kit does not model PostgreSQL exclusion constraints, so pretending the generated schema were complete would omit the most important invariant. The migration runner records the reviewed file in `app_migrations` and applies it transactionally.

Ranges are half-open (`[start,end)`). That makes adjacent appointments legal: a 10:00 appointment may begin exactly when a 09:30 appointment ends. UTC instants are stored in `tstzrange`; the doctor's IANA timezone is used only while expanding recurring wall-clock rules. Passing `now` into the calculator keeps “past” deterministic in tests.

The assignment calls `getFreeSlots(doctorId, from, to)` a pure function, but fetching by ID is I/O. The implementation deliberately separates `getFreeSlots(snapshot, from, to, now)` (pure) from `createAvailabilityService(...).getFreeSlotsForDoctor(doctorId, ...)` (I/O). This is easier to explain and test than hiding a database dependency behind a supposedly pure signature.

The external calendar boundary returns both busy intervals and a retrieval timestamp. The service rejects data older than the named two-minute freshness limit and fails closed if Google or Cal.com is unavailable. Two minutes is a starting operational policy, not a claim that calendars offer transactional reads; Phase 3 will make it configurable. Silently treating a failed calendar as empty would risk a real-world double booking.

### Alternatives rejected

- **Checking overlaps only in application code:** rejected because a read-then-insert check has a race window.
- **Separate `starts_at` and `ends_at` columns:** workable, but `tstzrange` expresses overlap and index usage directly and makes invalid boundary conventions harder to introduce.
- **Storing recurring hours in UTC:** rejected because a 09:00 clinic start would shift on DST transitions. Rules are local wall time; concrete slots are UTC.
- **Mocking Postgres in constraint tests:** rejected because mocks cannot prove GiST exclusion behavior or SQLSTATE values. Tests use embedded PostgreSQL with the actual `btree_gist` extension.
- **Duplicating the repeated autumn DST hour:** rejected for clinic scheduling safety. `TZDate` resolves one instant; ambiguous overnight schedules are under-offered rather than offered twice. A future admin UI should reject ambiguous overnight rules explicitly.
- **Using an in-memory availability provider as the system of record:** rejected. Postgres appointments and leave remain authoritative; the provider interface only adds external busy time and later write-back.

### Failure modes and intended behavior

- A competing insert wins first: Postgres rejects the loser with `23P01`; Phase 2 will translate that into a speakable message and fresh alternatives.
- The same request is retried: the unique idempotency key and conflict-return pattern produce the original row rather than a duplicate.
- A spring-forward wall time does not exist: that rule occurrence is skipped rather than normalized to an hour the doctor did not configure.
- The external calendar is down or times out: the eventual adapter must fail closed and tell the caller that live availability cannot be confirmed. Cached data may only be used within a documented freshness window and must be labelled as such.
- Calendar write-back fails after the Postgres booking commits: Postgres remains authoritative, the appointment is marked `failed` for calendar sync, the caller is told the clinic recorded the booking, and a retry job must reconcile it. The adapter must reuse the appointment ID as its idempotency key.
- The migration lacks permission to enable `btree_gist`: deployment fails transactionally; the runbook must direct an operator to enable the extension before retrying.

### Query plans captured on the Phase 1 schema

These plans came from PostgreSQL via PGlite with one doctor, five weekly rules, and one appointment. Small fixtures make absolute timings unrepresentative; the important evidence is the chosen access path. Production plans will be recaptured against Neon data before launch.

Weekly-rule lookup used the partial doctor/day index:

```text
Sort  (cost=9.51..9.52 rows=2 width=22) (actual time=0.183..0.195 rows=5.00 loops=1)
  Sort Key: day_of_week, start_time
  Sort Method: quicksort  Memory: 17kB
  Buffers: shared hit=7
  ->  Bitmap Heap Scan on availability_rules  (cost=4.16..9.50 rows=2 width=22) (actual time=0.080..0.101 rows=5.00 loops=1)
        Recheck Cond: ((doctor_id = '10000000-0000-4000-8000-000000000001'::uuid) AND is_active)
        Heap Blocks: exact=1
        ->  Bitmap Index Scan on availability_rules_doctor_day_idx
              Index Cond: (doctor_id = '10000000-0000-4000-8000-000000000001'::uuid)
Planning Time: 0.489 ms
Execution Time: 0.274 ms
```

Booked-range overlap used the GiST index created by the exclusion constraint:

```text
Index Only Scan using appointments_no_doctor_overlap on appointments
  (cost=0.12..8.15 rows=1 width=16) (actual time=0.204..0.207 rows=1.00 loops=1)
  Index Cond: ((doctor_id = '10000000-0000-4000-8000-000000000001'::uuid)
    AND (time_span && '["2027-01-12 05:00:00+05","2027-01-13 05:00:00+05")'::tstzrange))
  Heap Fetches: 1
  Index Searches: 1
  Buffers: shared hit=2
Planning Time: 0.401 ms
Execution Time: 0.238 ms
```

### Explainability notes for interview discussion

The shortest accurate explanation is: “Weekly schedules describe local intent, the pure function turns that intent into UTC candidates, busy sources subtract candidates, and Postgres still decides the winner at insert time.” The tests mirror that story from deterministic calculation through the final database invariant.

JSON and generated lockfiles cannot begin with comments without becoming invalid. The 2–4 line file header rule is applied to every source, SQL, Markdown, and environment-example file where the format permits comments.

Next.js 16.4.0 produced a native `SIGBUS` in this build environment under both Turbopack and Webpack. The project is pinned to 16.3.8, which completed the production build on the same Node 24 runtime. This is an evidence-based stability pin, not an assumption that newest is always safest.

## Inter-phase UI preview

The original Phase 1 placeholder was not useful for visual review, so a synthetic live-call preview was added at the user's request before Phase 2. It is deliberately labelled “Preview data”: the interaction demonstrates hierarchy, responsive behavior, call state, and light/dark themes without implying Retell or patient APIs are already connected. The full multi-page UI remains a Phase 4 deliverable.

The visual direction is a clinical operations console rather than a generic KPI dashboard. A deep-green voice field is the single expressive element; surrounding surfaces stay quiet and information-dense. Rejected alternatives were decorative gradients, rows of vanity metrics, and identical cards, because none help a receptionist understand the current call.

## Phase 2 — tool API, rate limiting, and calendar sync

### What was built

- Five POST routes under `/api/tools/*`. Each is a three-line adapter: `createToolRoute(name, schema, method)`. The shared adapter owns rate limiting, strict Zod parsing, request IDs, error mapping, and one structured log line per call.
- `AppointmentToolService` holds every business rule and returns `{ ok, code, message, data }`. `message` is safe to speak aloud; `code` is stable for evals.
- `PostgresClinicRepository` is the only runtime module that contains SQL, including the availability snapshot, rate-limit counter, and health probe. The domain availability service receives a snapshot loader function instead of importing the database.
- `CalendarSync` mirrors committed appointments to Google Calendar. Tool calls use it inline, and `/api/internal/calendar-sync` reuses it for retries.

### Why these choices

Postgres is the system of record. Availability reads fail closed: if a doctor has a calendar configured and Google cannot be read, is stale, or has no credentials, the tool returns `calendar_unavailable` (503) rather than offering possibly double-booked slots. Writes made after a booking commits fail open: the appointment stands, `calendar_sync_status` becomes `failed`, the caller hears that the calendar will update shortly, and the reconciler retries later.

Every calendar write is idempotent because the Google event ID is derived from the appointment UUID. `upsertBooking` inserts the event; if Google answers 409, it patches the existing event's times and restores `status: confirmed`. Cancellation accepts 404 and 410. Create and reschedule therefore share one operation, and the reconciler can replay any row without tracking what happened before.

The reconciler only claims rows untouched for 60 seconds, so it does not race an in-flight request. The age check uses the database's `now()` because the database wrote `updated_at`. Comparing it with the application clock would let clock skew decide which rows are eligible.

Rate limiting uses a fixed 60-second window keyed by tool and client address. The increment is one atomic upsert, and a data-modifying CTE prunes that key's expired windows in the same round trip.

### Defects found while finishing the phase

- **Drizzle broke raw date handling.** `drizzle(sql)` rewrites the shared postgres.js client's timestamp serializers and parsers. Every repository query that bound a `Date` threw, and range bounds came back as strings. Runtime code now uses a plain client (`createSqlClient`). Only the seed script creates a Drizzle-owned client. The new wire-protocol tests caught this; the previous Phase 2 code had no tests.
- **Idempotent replays were rejected.** A retried booking re-checked availability, found its own appointment in the slot, and answered "slot taken". Replays are now detected by idempotency key before the availability check, and payload mismatches return `idempotency_key_reused`.
- **Connection leak in production.** The runtime was cached only outside production, so each production request created a new pool.
- **Ambiguous verification.** Two patients sharing a name and date of birth verified as whichever row Postgres returned first. Ambiguous matches now verify no one.
- **Calendar errors became 500s.** Google 5xx responses escaped as generic errors instead of the fail-closed `calendar_unavailable` message.
- **Inaccurate spoken outcome.** `slot_just_taken` was also returned for times that were never offered. It is now `slot_unavailable`, with wording that is true in both cases.

### Alternatives rejected

- **Mocking postgres.js in service tests:** rejected for the same reason as in Phase 1. A mock would have hidden the Drizzle codec defect. Tests run PGlite behind `@electric-sql/pglite-socket`, so the production client speaks the real wire protocol.
- **Separate create and reschedule calendar calls:** rejected because the reconciler would need to know which call had last succeeded. One upsert operation has no such state.
- **An in-memory or Redis rate limiter:** in-memory counters are per-instance on Vercel. Redis would add infrastructure for a counter that Postgres already serializes.
- **Logging driver error messages:** rejected because Postgres messages can echo row values such as phone numbers. Logs record the error class and SQLSTATE only.

### Failure modes and intended behavior

- Two callers race for one slot: one insert wins, the other gets `23P01` and receives up to three alternatives from the following week.
- The same booking request arrives twice: the original appointment is returned, and a failed calendar sync is retried along the way.
- Google is down during availability: `calendar_unavailable`, HTTP 503, and no slots are offered.
- Google is down after a booking: the booking stands, its status is `failed`, and the reconciler retries it.
- The reconciler is not scheduled: rows remain visibly `failed`, and the next tool call that touches the appointment retries them.
- The rate limit is exceeded: HTTP 429 with `Retry-After`, sent before the body is parsed.

## UI redesign (inter-phase)

The preview was rebuilt using patterns from current AI-product interfaces: Geist Sans and Mono, hairline borders, and one clinical-green accent defined as semantic OKLCH tokens, so light and dark themes are each defined once. Tool calls appear inline in the transcript next to the turns that triggered them, with result codes and latency, so operators can audit the agent where decisions happen. A "Booking" panel separates an offered slot from a confirmed booking. Motion is limited to press feedback, a short entry stagger, and the voice visualizer, and reduced-motion preferences remove positional and continuous animation. Theme preference uses the inline-script pattern from the Next 16 documentation, so dark mode does not flash. The project rule against decorative metrics still applies: no KPI tiles were added.

## Phase 0: Setup and Environment Architecture

### What changed
- Replaced Neon with Supabase PostgreSQL.
- Established dual-connection topology: `DATABASE_URL` (Supabase transaction pooler on port 6543) for runtime queries, and `DIRECT_URL` (direct PostgreSQL on port 5432) for Drizzle migrations.
- Runtime connection configured with `prepare: false` to accommodate Supabase transaction pooling constraints.
- Environment variables centralized and validated with Zod in `src/lib/env.ts` and `src/config/environment.ts`.
- `RETELL_API_KEY` and `RETELL_AGENT_ID` made optional at initialization to decouple backend execution, tests, and CI from live telephony credentials.
- Scaffolded `evals/`, `agent/`, and drizzle-kit configuration (`drizzle.config.ts`).

### Why these choices (Pooler vs. Direct Connection)
- **Supabase Transaction Pooler (port 6543):** Serverless instances (such as Next.js route handlers on Vercel) rapidly spawn and tear down connections. Supabase's transaction pooler multiplexes these across shared database connections, protecting the database engine against connection starvation during traffic spikes. Because the Supabase transaction pooler does not preserve prepared statement caches across transactions, `postgres.js` must run with `prepare: false`.
- **Direct Connection (`DIRECT_URL`, port 5432):** Schema migrations (`drizzle-kit migrate`, DDL operations) require session-level privileges and transactional locks that transaction poolers either disrupt or disallow. Migration steps therefore connect directly to Postgres on port 5432.
- **Optional Retell credentials:** Allows full backend development, unit testing, wire-protocol database testing, and evaluation runs without requiring an active voice provider contract or exposing billable minutes.

### Alternatives rejected
- **Using session pooler for everything:** Rejected because session poolers hold onto database connections for the lifetime of the client, exhausting Supabase's connection limit during Vercel serverless scale-outs.
- **Validating all API keys strictly at startup:** Rejected because requiring `RETELL_AGENT_ID` before the agent is deployed creates a chicken-and-egg deployment deadlock.
- **Client-side Supabase SDK (`@supabase/supabase-js`) for database queries:** Rejected to preserve explicit SQL control, strict backend transaction boundaries, and ensure zero client-side leakage of database schema or privileges.

### How it can fail
- **Prepared statements enabled on the pooler:** If `prepare: false` is omitted, the Supabase transaction pooler will return `prepared statement "..." does not exist` errors as queries route across different pooler connections.
- **Running DDL migrations through the transaction pooler:** Running migrations via port 6543 can result in hung locks or unsupported transaction commands. Migrations must use `DIRECT_URL`.
- **Supabase project pause on free tier:** Supabase projects pause after periods of inactivity, causing connection timeouts (`ENOTFOUND` or connection refused). Requires dashboard unpausing prior to demonstrations.

### Vercel Cron Cadence & Calendar Sync Retry Policy
- **Vercel Hobby cron limitation:** Vercel Hobby accounts enforce a maximum cron schedule frequency of once per day (`0 4 * * *`). The previous `*/10 * * * *` cadence fails deployment on Vercel Hobby tier.
- **Protected route:** `/api/internal/calendar-sync` remains strictly protected by constant-time bearer authentication verifying `Authorization: Bearer <CRON_SECRET>`.
- **Next.js after() write retry:** When a calendar write fails following a successful Postgres appointment insert or cancellation, the tool route schedules a retry using Next.js `after()`, ensuring the serverless execution context completes without blocking the caller response, logging any failures with `request_id` and zero PHI.
- **High-frequency reconciliation alternative:** If a 10-minute reconciliation cadence is required, a GitHub Actions scheduled workflow (`cron: "*/10 * * * *"`) can curl the secured endpoint with the `CRON_SECRET` bearer token.

### Revive-on-Conflict Idempotency Tradeoff
- **The mechanism**: When an appointment is booked and subsequently cancelled within a call session, its `idempotency_key` remains stored on the cancelled row. If the caller subsequently re-books that identical slot in the same call session, `createAppointment` encounters a unique key collision on `appointments_idempotency_key_unique_idx`. The insert issues `ON CONFLICT (idempotency_key) DO UPDATE SET status = 'booked', reason = EXCLUDED.reason, calendar_sync_status = EXCLUDED.calendar_sync_status, time_span = EXCLUDED.time_span, updated_at = now()`, reviving the appointment row in place rather than creating an additional row.
- **Why this choice**: Prevents duplicate rows and dangling cancelled records for callers that cycle through booking decisions during a single voice session. Preserves the single authoritative row for downstream audit and call timeline association.
- **The tradeoffs & safeguards**:
  - *Rescheduling conflict detection*: If a booking was rescheduled to a new time and the original booking request is retried with the original idempotency key, `assertSameBooking` detects the changed time payload and explicitly rejects with `idempotency_key_reused` (409) rather than overwriting or resurrecting the old time.
  - *Intervening competitor protection*: If another patient books the slot after it was cancelled, either the domain availability check or PostgreSQL's GiST exclusion constraint (`appointments_no_doctor_overlap`) triggers with `23P01`. The catch block inspects the conflicting row: because `patient_id` belongs to the competing patient, revival is rejected and the caller receives `slot_unavailable` with fresh alternative slots.
  - *Audit trail*: Because the row is updated in place, the `updated_at` timestamp advances, while `created_at` records the original booking instant.




