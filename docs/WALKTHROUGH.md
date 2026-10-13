# End-to-End Walkthrough: From Caller Utterance to Appointments Row

This document traces the lifecycle of **ONE appointment booking** through every layer of the system: from the caller's spoken voice to a committed row in PostgreSQL.

---

## The Scenario
- **Caller**: Eleanor Vance (verified existing patient, ID: `36ecf076-a484-47d3-bd3d-b4d1c264e58b`).
- **Doctor**: Dr. Sarah Chen (Family Medicine, ID: `10000000-0000-4000-8000-000000000002`).
- **Selected Time**: Tuesday, October 20, 2026, at 9:00 AM – 9:30 AM EDT (`2026-10-20T13:00:00.000Z` to `2026-10-20T13:30:00.000Z`).
- **Active Retell Call ID**: `call_8829410a7bc3`.

---

## Step 1: Voice Capture & Speech-to-Text
1. **Action**: The caller speaks: *"The 9:00 AM slot would be wonderful, thank you."*
2. **Component**: Retell AI Voice Gateway.
3. **Processing**:
   - Audio streams via WebRTC/SIP to Retell's speech stack.
   - Audio is transcribed to text: `"The 9:00 AM slot would be wonderful, thank you."`

---

## Step 2: LLM Reasoning & Function Calling
1. **Component**: Retell LLM Orchestrator.
2. **Context**: Prompt constructed via [`src/integrations/retell/agent-definition.ts:buildPrompt`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/integrations/retell/agent-definition.ts#L185).
3. **Decision**:
   - The caller has previously received slot options from `check_availability` and confirmed the 9:00 AM slot.
   - Under Call Flow step 4 (Booking) and the Confirmation rule in the system prompt (`agent-definition.ts`), the model emits a structured tool invocation:
     ```json
     {
       "name": "book_appointment",
       "args": {
         "doctor_id": "10000000-0000-4000-8000-000000000002",
         "patient_id": "36ecf076-a484-47d3-bd3d-b4d1c264e58b",
         "start_at": "2026-10-20T13:00:00.000Z",
         "end_at": "2026-10-20T13:30:00.000Z",
         "reason": "Checkup"
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
     - Calls [`src/server/rate-limiter.ts:consumeRateLimit`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/rate-limiter.ts) via `runtime.consumeRateLimit`.
     - Uses in-memory sliding window rate limiter. Request is permitted (allowed = true).
   - **Schema Validation**:
     - Evaluates input with [`src/application/tool-schemas.ts:bookAppointmentSchema.safeParse`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/tool-schemas.ts). Input passes.

---

## Step 5: Deterministic Idempotency Key Derivation
1. **File**: [`src/app/api/tools/book-appointment/route.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/app/api/tools/book-appointment/route.ts)
2. **Function**: `deriveIdempotencyKey(callId, patientId, doctorId, startAt)`
3. **Computation**:
   - Canonical start time: `new Date("2026-10-20T13:00:00.000Z").toISOString()` = `"2026-10-20T13:00:00.000Z"`.
   - Hash source: `"call_8829410a7bc3:36ecf076-a484-47d3-bd3d-b4d1c264e58b:10000000-0000-4000-8000-000000000002:2026-10-20T13:00:00.000Z"`.
   - Produces SHA-256 digest: `idempotencyKey = "8f39a045...e92c"`.

---

## Step 6: Application Service Orchestration
1. **File**: [`src/application/appointment-tool-service.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/appointment-tool-service.ts)
2. **Function**: `AppointmentToolService.bookAppointment(input)`
3. **Workflow**:
   - Validates patient existence via `this.repository.findPatient("36ecf076-...")`.
   - Validates doctor existence and active status via `this.repository.findDoctor("10000000-...")`.
   - Executes `this.dependencies.getSlots(doctor.id, dayStart, dayEnd, now)` (created via [`src/domain/availability-service.ts:createAvailabilityService`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/domain/availability-service.ts)):
     - Loads live availability snapshot via `this.repository.loadAvailabilitySnapshot()`: reads rules, time-off, and existing booked appointments.
     - Optionally queries live calendar busy intervals via `calendar.getBusyTimes()`.
     - Invokes pure slot calculation engine [`src/domain/get-free-slots.ts:getFreeSlots`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/domain/get-free-slots.ts): anchors day in doctor's wall-clock timezone, drops invalid DST transition hours, and subtracts booked blocks.
   - Verifies the requested slot `[13:00, 13:30)` is in the resulting free slots list.

---

## Step 7: PostgreSQL Range Write & Exclusion Constraint Enforcement
1. **File**: [`src/db/postgres-clinic-repository.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/db/postgres-clinic-repository.ts)
2. **Function**: `PostgresClinicRepository.createAppointment(input)`
3. **SQL Execution**:
   ```sql
   INSERT INTO appointments
     (doctor_id, patient_id, time_span, reason, idempotency_key, calendar_sync_status)
   VALUES (
     '10000000-0000-4000-8000-000000000002',
     '36ecf076-a484-47d3-bd3d-b4d1c264e58b',
     tstzrange('2026-10-20 13:00:00+00', '2026-10-20 13:30:00+00', '[)'),
     'Checkup',
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
     The database checks for overlap during the insert, and a conflicting concurrent transaction waits for the first to commit or abort, then fails with 23P01 (exclusion_violation), preventing double-booking.
   - `appointments_idempotency_key_unique_idx`: Prevents duplicate inserts if Retell retried this request.
5. **Outcome**: The row is inserted into `appointments` with ID `8bd283b6-b272-450a-a86e-55d1de756830`.

---

## Step 8: External Calendar Synchronization
1. **Files**: [`src/application/appointment-tool-service.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/appointment-tool-service.ts) & [`src/server/tool-route.ts`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/tool-route.ts)
2. **Logic**:
   - `AppointmentToolService.bookAppointment` immediately invokes synchronous calendar sync via `this.dependencies.calendarSync.sync(appointment)`.
   - If Google Calendar is configured and succeeds, status is updated to `synced`. If not configured, status is `not_configured`.
   - If external calendar sync fails or times out, the local database booking still stands with `calendar_sync_status = 'pending'`, and the tool response returns code `appointment_booked_calendar_pending`.
   - When `result.code.endsWith("_calendar_pending")` is detected in `src/server/tool-route.ts`, it enqueues asynchronous background reconciliation via Next.js `after()`:
     ```ts
     after(async () => {
       await runtime.service.retryCalendarSync(appointmentId);
     });
     ```
   - `retryCalendarSync(appointmentId)` retrieves the appointment and calls [`src/application/calendar-sync.ts:CalendarSync.sync(appointment)`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/application/calendar-sync.ts), invoking `AvailabilitySource.write` to mirror the event to Google Calendar.

---

## Step 9: Audit Logging & PHI Redaction
1. **File**: [`src/server/tool-route.ts:recordToolCall`](file:///c:/Users/Deekshith%20J/OneDrive/Desktop/Deekshii%20agenr/Deekshii%20agenr/src/server/tool-route.ts)
2. **Logic**:
   - Calls `sanitizeArguments(args)`: redacts patient names, phone numbers, and dates of birth.
   - Writes to the `tool_calls` table in PostgreSQL (via an `INSERT INTO calls ... RETURNING id` CTE that ensures the parent call record exists): records `request_id`, `tool_name` (`book_appointment`), sanitized arguments without PHI, tool result, latency (e.g. 48 ms), and success status.

---

## Step 10: Response Delivery & Voice Synthesis
1. **HTTP Response**:
   `200 OK`
   ```json
   {
     "ok": true,
     "code": "appointment_booked",
     "message": "The appointment is booked.",
     "data": {
       "appointment_id": "8bd283b6-b272-450a-a86e-55d1de756830",
       "doctor_id": "10000000-0000-4000-8000-000000000002",
       "doctor_name": "Dr. Sarah Chen",
       "when": "Tuesday, October 20 at 9:00 AM",
       "start_at": "2026-10-20T13:00:00.000Z",
       "end_at": "2026-10-20T13:30:00.000Z",
       "status": "booked",
       "calendar_sync_status": "not_configured"
     }
   }
   ```
2. **Retell Voice Engine**:
   - Reads `message` and data payload.
   - Retell's speech stack converts the assistant's spoken confirmation into audio chunks streamed via WebRTC/SIP to the caller.
3. **Caller Hears**:
   - *"I have successfully booked your appointment with Dr. Sarah Chen for Tuesday, October 20th, at 9:00 AM. Is there anything else I can help you with today?"*

