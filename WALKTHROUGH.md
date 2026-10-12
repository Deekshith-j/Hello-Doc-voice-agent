# End-to-End Walkthrough: From Caller Utterance to Appointments Row

This document traces the lifecycle of **ONE appointment booking** through every layer of the system: from the caller's spoken voice to a committed row in PostgreSQL.

---

## The Scenario
- **Caller**: John Doe (verified existing patient, ID: `d8b242e8-c51f-4b06-a812-32b07d6a5e12`).
- **Doctor**: Dr. Sarah Chen (Internal Medicine, ID: `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`).
- **Selected Time**: Tuesday, October 14, 2026, at 9:30 AM – 10:00 AM EDT.
- **Active Retell Call ID**: `call_8829410a7bc3`.

---

## Step 1: Voice Capture & Speech-to-Text
1. **Action**: The caller speaks: *"Yes, please book Tuesday at 9:30 AM with Dr. Chen."*
2. **Component**: Retell AI Voice Gateway.
3. **Processing**:
   - Audio streams via WebRTC/SIP to Deepgram Nova-2 ASR.
   - Audio is transcribed to text: `"Yes, please book Tuesday at 9:30 AM with Dr. Chen."`

---

## Step 2: LLM Reasoning & Function Calling
1. **Component**: Retell LLM Orchestrator.
2. **Context**: Prompt constructed via [`src/integrations/retell/agent-definition.ts:buildPrompt`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/integrations/retell/agent-definition.ts#L184).
3. **Decision**:
   - The caller has previously confirmed slot details and answered "yes".
   - Under Prompt Rule 4 (Booking), the model emits a structured tool invocation:
     ```json
     {
       "name": "book_appointment",
       "args": {
         "doctor_id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
         "patient_id": "d8b242e8-c51f-4b06-a812-32b07d6a5e12",
         "start_at": "2026-10-14T13:30:00.000Z",
         "end_at": "2026-10-14T14:00:00.000Z",
         "reason": "Routine checkup"
       }
     }
     ```

---

## Step 3: Webhook Dispatch & Cryptographic Signing
1. **Component**: Retell Webhook Egress.
2. **Processing**:
   - Generates UNIX timestamp `t = 1791834000`.
   - Computes HMAC-SHA256 hash using `RETELL_API_KEY`:
     `signature = "v=" + t + ",d=" + hex(hmac_sha256(raw_body, key))`.
   - Dispatches HTTP `POST` to `https://clinic.example.com/api/tools/book-appointment`.
   - Headers:
     - `Content-Type: application/json`
     - `x-retell-signature: v=1791834000,d=3f89a...`
     - `x-request-id: 7e4b931a-6372-4d51-9e28-fa1199320e8b`

---

## Step 4: Route Handling & Security Guardrails
1. **File**: [`src/server/tool-route.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/tool-route.ts)
2. **Function**: `createToolRoute.POST(request: Request)`
3. **Steps**:
   - **HMAC Verification**: Passes `rawBody` and `x-retell-signature` to [`src/server/retell-request.ts:authenticateRetellRequest`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/retell-request.ts).
     - Checks timestamp drift (< 300 seconds).
     - Recalculates HMAC-SHA256 using `timingSafeEqual`. Validated.
   - **Payload Unwrapping**: Unwraps Retell envelope via `unwrap(parseJson(rawBody))`.
     - Extracts `callId = "call_8829410a7bc3"`.
   - **Per-Call Rate Limiting**: In `runTool()`:
     - Generates key: `"book_appointment:call:call_8829410a7bc3"`.
     - Calls [`src/server/rate-limiter.ts:DatabaseRateLimiter.consumeRateLimit`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/rate-limiter.ts).
     - Increments bucket in PostgreSQL. Limit is permitted (allowed = true).
   - **Schema Validation**:
     - Evaluates input with [`src/application/tool-schemas.ts:bookAppointmentSchema.safeParse`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/tool-schemas.ts). Input passes.

---

## Step 5: Deterministic Idempotency Key Derivation
1. **File**: [`src/app/api/tools/book-appointment/route.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/app/api/tools/book-appointment/route.ts)
2. **Function**: `deriveIdempotencyKey(callId, patientId, doctorId, startAt)`
3. **Computation**:
   - Canonical start time: `new Date("2026-10-14T13:30:00.000Z").toISOString()` = `"2026-10-14T13:30:00.000Z"`.
   - Hash source: `"call_8829410a7bc3:d8b242e8-c51f-4b06-a812-32b07d6a5e12:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11:2026-10-14T13:30:00.000Z"`.
   - Produces SHA-256 digest: `idempotencyKey = "8f39a045...e92c"`.

---

## Step 6: Application Service Orchestration
1. **File**: [`src/application/appointment-tool-service.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/appointment-tool-service.ts)
2. **Function**: `AppointmentToolService.bookAppointment(input)`
3. **Workflow**:
   - Validates patient existence via `this.repository.findPatient("d8b242e8-...")`.
   - Validates doctor existence and active status via `this.repository.findDoctor("a0eebc99-...")`.
   - Fetches live availability snapshot via `this.repository.loadAvailabilitySnapshot()`:
     - Reads weekly operating rules from `availability_rules`.
     - Reads approved leave from `time_off`.
     - Reads existing booked appointments from `appointments`.
   - Verifies slot availability via [`src/domain/get-free-slots.ts:getFreeSlots`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/domain/get-free-slots.ts):
     - Calculates wall-clock local time in `"America/New_York"`.
     - Discards nonexistent DST jump hours.
     - Confirms requested window `[13:30, 14:00)` is completely free.

---

## Step 7: PostgreSQL Range Write & Exclusion Constraint Enforcement
1. **File**: [`src/db/postgres-clinic-repository.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/db/postgres-clinic-repository.ts)
2. **Function**: `PostgresClinicRepository.createAppointment(input)`
3. **SQL Execution**:
   ```sql
   INSERT INTO appointments
     (doctor_id, patient_id, time_span, reason, idempotency_key, calendar_sync_status)
   VALUES (
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'd8b242e8-c51f-4b06-a812-32b07d6a5e12',
     tstzrange('2026-10-14 13:30:00+00', '2026-10-14 14:00:00+00', '[)'),
     'Routine checkup',
     '8f39a045...e92c',
     'pending'
   )
   ON CONFLICT (idempotency_key) DO UPDATE
     SET status = 'booked',
         reason = EXCLUDED.reason,
         calendar_sync_status = EXCLUDED.calendar_sync_status,
         time_span = EXCLUDED.time_span,
         updated_at = now()
   RETURNING id, doctor_id, patient_id, reason, status, calendar_sync_status,
             lower(time_span) AS start_at, upper(time_span) AS end_at;
   ```
4. **PostgreSQL Storage Engine Constraints Enforced**:
   - `appointments_valid_range_check`: Verifies interval is non-empty and half-open `[)`.
   - `appointments_no_doctor_overlap`:
     ```sql
     EXCLUDE USING gist (doctor_id WITH =, time_span WITH &&) WHERE (status = 'booked')
     ```
     PostgreSQL locks the corresponding leaf index page in the GiST tree. If another transaction booked an overlapping time for Dr. Chen in the microsecond before, PostgreSQL raises error code `23P01` (exclusion_violation), preventing double-booking.
   - `appointments_idempotency_key_unique_idx`: Prevents duplicate inserts if Retell retried this request.
5. **Outcome**: The row is inserted into `appointments` with ID `e5f1b892-482a-41cb-9184-e9e92fa08210`.

---

## Step 8: External Calendar Synchronization (Asynchronous)
1. **File**: [`src/server/tool-route.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/tool-route.ts)
2. **Logic**:
   - Tool response contains `_calendar_pending`.
   - Schedules background sync using Next.js `after()` API:
     ```ts
     after(async () => {
       await runtime.service.retryCalendarSync(appointmentId);
     });
     ```
   - Invokes [`src/application/calendar-sync.ts:CalendarSync.syncAppointment`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/calendar-sync.ts).
   - Calls Google Calendar API to insert event. On success, updates `calendar_sync_status = 'synced'`.

---

## Step 9: Audit Logging & PHI Redaction
1. **File**: [`src/server/tool-route.ts:recordToolCall`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/tool-route.ts)
2. **Logic**:
   - Calls `sanitizeArguments(args)`: redacts patient names, phone numbers, and dates of birth.
   - Writes to `calls` table in PostgreSQL: records tool name (`book_appointment`), request ID, latency (e.g. 48 ms), and status.

---

## Step 10: Response Delivery & Voice Synthesis
1. **HTTP Response**:
   `200 OK`
   ```json
   {
     "ok": true,
     "code": "appointment_booked",
     "message": "You are confirmed for Tuesday, October 14 at 9:30 AM with Dr. Sarah Chen.",
     "data": {
       "appointment_id": "e5f1b892-482a-41cb-9184-e9e92fa08210",
       "doctor_name": "Dr. Sarah Chen",
       "when": "Tuesday, October 14 at 9:30 AM"
     }
   }
   ```
2. **Retell Voice Engine**:
   - Reads `message` property.
   - ElevenLabs streaming TTS converts the sentence to audio chunks.
3. **Caller Hears**:
   - *"You are confirmed for Tuesday, October 14 at 9:30 AM with Dr. Sarah Chen."*
