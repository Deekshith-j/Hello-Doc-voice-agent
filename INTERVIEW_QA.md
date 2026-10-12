# Technical Interview Q&A: 15 Hardest Engineering Questions

This document prepares you for a deep-dive technical interview on the Docto architecture, concurrency guarantees, telephony integrations, and evaluation harness.

---

### 1. Concurrency: Why can't we prevent double-booking using application-level `SELECT ... WHERE NOT EXISTS` followed by `INSERT`?
**Short Answer**:
Under PostgreSQL's default `READ COMMITTED` isolation level, two concurrent transactions checking the same time slot will both read zero overlapping rows before either commits. Both transactions proceed to insert, causing an immediate double-booking. Even under `SERIALIZABLE` isolation, one transaction aborts with a serialization error (`40001`), leading to expensive retry loops and degraded telephony latency.

**How it can fail**:
If someone removes the PostgreSQL GiST exclusion constraint and relies on application code or advisory locks, concurrent phone callers selecting the same slot at the same second will double-book the doctor.

---

### 2. Database Constraints: How does the PostgreSQL GiST Exclusion Constraint work, and why is `btree_gist` required?
**Short Answer**:
An exclusion constraint (`EXCLUDE USING gist (doctor_id WITH =, time_span WITH &&) WHERE (status = 'booked')`) enforces interval non-overlap natively in the storage engine. The database checks for overlap during the insert, and a conflicting concurrent transaction waits for the first to commit or abort, then fails with 23P01. `btree_gist` is required because standard GiST indexes only index geometric or range types; `btree_gist` allows standard scalar types (like `uuid` for `doctor_id`) to be indexed alongside `tstzrange` in a single unified index scan.

**How it can fail**:
If an engineer attempts to run migrations without superuser/extension privileges to execute `CREATE EXTENSION IF NOT EXISTS btree_gist;`, the migration immediately fails. Also, partial indexes only enforce non-overlap across rows matching `WHERE (status = 'booked')`; if an appointment is incorrectly soft-deleted or updated to another status, its range is freed.

---

### 3. Timezones & DST: How does `getFreeSlots` handle Daylight Saving Time (DST) cutovers and timezones?
**Short Answer**:
Clinic operating hours (e.g. "Monday 09:00 - 17:00") exist exclusively in the doctor's wall-clock clinic timezone (`America/New_York`). `getFreeSlots` expands discrete calendar days anchored to the doctor's local timezone using `@date-fns/tz`. During a "spring forward" cutover, nonexistent wall-clock times (e.g., 2:30 AM) are detected via `zoned.getHours() !== hour` and returned as `null` (dropped). During a "fall back" cutover, 25-hour days are expanded deterministically to standard UTC offsets.

**How it can fail**:
If an engineer converts operating hours into UTC naively by adding 24-hour increments (`+ 86,400,000 ms`), DST transition days (which have 23 or 25 hours) will shift every subsequent appointment slot by +/- 1 hour for the entire clinic schedule.

---

### 4. Interval Arithmetic: Why are appointments modeled as half-open ranges `[start, end)`?
**Short Answer**:
Appointments are half-open intervals: inclusive of start time, exclusive of end time (`[)` in PostgreSQL `tstzrange`). This allows back-to-back scheduling: an appointment ending at 10:00 AM does not overlap an appointment starting at 10:00 AM (`10:00 < 10:00` is false).

**How it can fail**:
If code or queries accidentally construct closed intervals `[]`, back-to-back appointments will collide, raising exclusion violations `23P01` and artificially cutting doctor schedule capacity in half.

---

### 5. Idempotency: Why derive idempotency keys on the server instead of trusting the voice LLM or client?
**Short Answer**:
Voice LLMs cannot reliably remember, generate, or preserve UUID idempotency keys across conversation turns or network disconnects. We derive a deterministic SHA-256 hash on the server from `call_id + patient_identifier + doctor_id + canonical_start_at`.

**How it can fail**:
If the caller changes their mind and re-books the exact same time slot on the *same* phone call after cancelling, the derived key will match the previous attempt, potentially returning the earlier cached record unless the key accounts for operation verb or timestamp sequencing.

---

### 6. Webhook Retries: How does `ON CONFLICT (idempotency_key) DO UPDATE` handle Retell network retries?
**Short Answer**:
If Retell's upstream HTTP client times out at 3000ms while Next.js is writing to Postgres, Retell immediately retries the webhook. The unique index on `idempotency_key` intercepts the second write, atomically updates mutable metadata (e.g., status to `'booked'`), and returns the winning row without creating a duplicate appointment or raising a 500 error.

**How it can fail**:
If two requests with the same idempotency key arrive concurrently before the first transaction commits, one transaction will block on index locking until the first completes, then proceed to the `DO UPDATE` branch. However, if the payload in the retry has changed critical fields (e.g. a different doctor), `idempotency_key` will either reject it or cause unexpected mutation.

---

### 7. Security: How does Retell HMAC-SHA256 signature verification work, and what does it defend against?
**Short Answer**:
Every inbound Retell request carries `x-retell-signature: v=<timestamp>,d=<hash>`. The server computes `HMAC-SHA256(raw_body, RETELL_API_KEY)`. We compare the digest using constant-time `crypto.timingSafeEqual` and enforce a 5-minute maximum timestamp drift. This prevents unauthorized callers from forging tool actions, replay attacks, and timing attacks.

**How it can fail**:
If Next.js middleware or body parsers mutate or format whitespace in the raw JSON payload before `authenticateRetellRequest(rawBody)` inspects it, the HMAC digest will mismatch, rejecting 100% of legitimate Retell tool calls with 401 Unauthorized.

---

### 8. Database Networking: Why do we need both a Pooler URL (`DATABASE_URL`) and a Direct URL (`DIRECT_URL`)?
**Short Answer**:
Serverless Next.js functions scale horizontally to hundreds of ephemeral instances. Connecting directly to Postgres would exhaust PostgreSQL's max connection limits (`max_connections=100`). The Supabase transaction pooler (port 6543) multiplexes short queries over a small pool of shared database connections. However, the Supabase transaction pooler in transaction mode does not support session-level features like `LISTEN/NOTIFY`, advisory locks, or schema migrations; hence, DDL migrations and seed scripts require `DIRECT_URL` (port 5432).

**How it can fail**:
If application code runs schema migrations or uses prepared statements with session pin requirements over the transaction pooler, queries will fail with `prepared statement does not exist` or protocol synchronization errors.

---

### 9. Row Level Security (RLS): Why does the codebase enforce authorization in application SQL queries rather than PostgreSQL RLS policies?
**Short Answer**:
RLS is enabled with no policies to block Supabase's public API roles; the server connects as the database owner role, which bypasses RLS; access control is enforced in application code (patient ownership checks).

**Detailed Rationale**:
In voice telephony, incoming requests authenticate server-to-server via Retell HMAC signatures rather than user-session JWTs. Enforcing PostgreSQL Row Level Security (RLS) would require executing `SET LOCAL app.current_patient_id = ...` on every transaction. Because serverless Next.js functions connect through the Supabase transaction pooler in transaction pooling mode (`DATABASE_URL`), session-level state and configuration variables can bleed between pooled connections or reset unpredictably. Instead, repository queries explicitly parameterize and enforce patient ownership in SQL (`WHERE id = ${id} AND patient_id = ${patientId}`), while `handleRouteError` redacts driver error messages to prevent PHI leakage.

**How it can fail**:
If an engineer adds a new repository method that queries appointments by ID alone (`WHERE id = ${id}`) without joining or checking `patient_id`, an attacker guessing a UUID could inspect or cancel another patient's appointment. Defense-in-depth requires strict query review and schema-level tenant isolation in multi-tenant deployments.

---

### 10. Gateway Compatibility: What is the "web-call v3 gateway bug", and why does the codebase use `/v2/create-web-call`?
**Short Answer**:
In Retell's API evolution, v3 introduced breaking structural differences in authentication envelopes and agent configuration payloads compared to v2. Calling `/v3/create-web-call` fails or produces unparseable responses when used with standard Retell Web SDK clients expecting v2 ephemeral access tokens. The codebase pins to `/v2/create-web-call` in `src/app/api/retell/web-call/route.ts` for rock-solid browser compatibility.

**How it can fail**:
If an engineer updates the SDK or URL endpoint to `/v3` without refactoring the client-side `RetellWebClient` token handshake, all browser web demo calls will fail to connect with WebSocket handshake rejections.

---

### 11. Multi-Tier Evals: Why evaluate the agent across DB State, Tool Trace, and LLM Judge instead of an LLM judge alone?
**Short Answer**:
LLMs suffer from judge hallucination: a conversational judge can easily believe an agent who says "I have booked your appointment" even when the tool call actually failed, crashed, or was never invoked.
- **DB State Grader**: Objective ground truth (did rows actually mutate in PostgreSQL without violating constraints?).
- **Tool Trace Grader**: Strict clinical protocol (was identity verified *before* booking? Was check_availability called first?).
- **LLM Judge**: Evaluates subjective bedside manner, emergency redirects, conversational pacing, and refusal of medical advice.

**How it can fail**:
If an evaluation test relies solely on the LLM judge, an agent that hallucinates a booking without executing any database writes will receive a 100% false-positive passing grade.

---

### 12. Rate Limiting: Why is IP-based rate limiting broken for telephony agents, and why do we rate-limit per call?
**Short Answer**:
All inbound tool calls from Retell originate from Retell's centralized telephony proxy infrastructure (shared NAT/egress IP addresses). Rate limiting by client IP (`x-forwarded-for`) would throttle *all* callers across the entire clinic whenever total volume increases. Instead, `src/server/tool-route.ts` extracts `call_id` from the Retell envelope and rate limits per `${tool.name}:call:${callId}`.

For public browser demo calls on `/api/retell/web-call`, we enforce two in-memory sliding window limits: 5 per IP per hour and 30 per day overall, both per serverless instance (not concurrency).

**How it can fail**:
If an attacker invokes tool endpoints directly without a `call_id` (attempting an external denial-of-service attack), the system falls back to IP limiting. However, if the HMAC signature check were disabled or bypassed, an attacker could spoof random `call_id` values to bypass rate limits entirely. Additionally, because the web-call demo limits are evaluated in-memory per serverless instance (5 per IP per hour and 30 per day overall), traffic distributed across multiple serverless instances will evaluate separate memory buckets rather than a centralized Redis state.

---

### 13. Identity Verification: Why is Name + Date of Birth weak verification, and what is the clinical failure mode?
**Short Answer**:
Full name and date of birth are standard outpatient clinic identifiers, but they are not cryptographic proof of identity. They can be known by family members, roommates, or social engineers.

**How it can fail**:
An adversarial caller can look up another patient's appointment schedule or cancel their surgeries simply by providing their public name and birthday. In production, HIPAA-compliant deployments require multi-factor SMS OTP or ANI (Caller ID matching) verification before exposing appointment history or cancellations.

---

### 14. Calendar Sync: Why is Google Calendar sync decoupled asynchronously with `after()`, and how can it fail?
**Short Answer**:
External calendar APIs (Google Calendar / Cal.com) have high p99 latencies (often 800ms - 2500ms) and occasional network outages. Holding the Retell voice tool HTTP request open while awaiting Google Calendar would cause voice lag and agent timeout errors. The system commits to PostgreSQL immediately with `calendar_sync_status = 'pending'`, returns a voice response to the caller in <100ms, and enqueues sync via Next.js `after()`.

**How it can fail**:
In serverless environments (Vercel/AWS Lambda), if the execution container is abruptly terminated after the HTTP response closes, background work in `after()` can be killed before completing. To prevent permanent desynchronization, a periodic background worker (`retryCalendarSync`) must poll for `calendar_sync_status = 'pending'` rows older than 60 seconds.

---

### 15. Safe Fallbacks: Why does `create_patient` redirect to the front desk when conflicting records are found?
**Short Answer**:
If a caller tries to register a name and DOB that already exists with a different ID, or provides a phone number already assigned to an existing profile, the automated voice agent cannot determine whether this is a legal name change, an estranged relative sharing a phone, or malicious identity theft.

**How it can fail**:
If the voice agent blindly merged or overwritten patient profiles, medical charts, prescriptions, and allergies would cross-contaminate between different patients, creating catastrophic medical and legal liabilities. Defensive refusal protects patient safety.
