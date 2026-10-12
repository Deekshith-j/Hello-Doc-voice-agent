# Docto — AI Clinic Appointment Voice Agent

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-336791?style=flat-square&logo=postgresql)](https://supabase.com/)
[![Retell AI](https://img.shields.io/badge/Retell_AI-Voice_Agent-7c3aed?style=flat-square)](https://retellai.com/)
[![Tests](https://img.shields.io/badge/Tests-103_Passed-success?style=flat-square&logo=vitest)](https://vitest.dev/)

Docto is an autonomous AI voice receptionist for clinical front desks. Powered by **Retell AI** (`gpt-6-luna`), PostgreSQL concurrency-safe exclusion constraints, and two-way Google Calendar synchronization, Docto handles patient lookup, availability checking, scheduling, rescheduling, and cancellations over phone and browser web calls in real time.

Live Deployment: [https://docto-agent.vercel.app](https://docto-agent.vercel.app)

---

## Application Preview

![Docto Live Call Workspace](docs/images/dashboard.png)

*The live front-desk workspace: real-time call stage, live transcript stream, tool execution audit trail, and clinic agenda.*

---

## Key Features

- **Conversational Voice Scheduling**: Real-time natural phone & browser audio calls powered by Retell AI with sub-second latency and interruption handling.
- **Race-Condition Proof Double-Booking Prevention**: PostgreSQL GiST exclusion constraints (`appointments_no_doctor_overlap`) enforce database-level slot locks across concurrent callers.
- **Strict Server-Derived Idempotency**: Cryptographic hashes of `call_id + patient_id + doctor_id + start_at` guarantee repeat tool calls never duplicate records.
- **Two-Way External Calendar Sync**: Non-blocking Google Calendar integration that records bookings locally immediately, then syncs external calendars with background retries.
- **Real-Time Operator Observability**: Interactive dashboard streaming live call transcripts, step-by-step tool invocations, upcoming appointments, and provider shifts.
- **Automated Tool Contract Eval Suite**: Benchmark test harness evaluating tool schemas, availability accuracy, and edge-case multi-turn scenarios.

---

## Architecture Overview

```text
                  ┌────────────────────────┐
                  │    Patient / Caller    │
                  └───────────┬────────────┘
                              │ Voice (WebRTC / Telephony)
                              ▼
                  ┌────────────────────────┐
                  │    Retell AI Voice     │
                  └───────────┬────────────┘
                              │ Signed HTTP Function Calls & Webhooks
                              ▼
                  ┌────────────────────────┐
                  │   Next.js API Engine   │
                  │   (/api/tools/*)       │
                  └─────┬────────────┬─────┘
                        │            │
       PostgreSQL DDL / │            │ Google Calendar API
       GiST Range Locks │            │ Free/Busy & Event Upsert
                        ▼            ▼
        ┌──────────────────┐      ┌──────────────────┐
        │ Supabase / PG    │      │ Google Calendar  │
        │ (Truth Source)   │      │ (External Sync)  │
        └──────────────────┘      └──────────────────┘
```

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend & UI** | Next.js 16 (App Router), React 19, Tailwind CSS v4, Lucide Icons |
| **Backend API** | Next.js Route Handlers, Server Actions, Node.js crypto primitives |
| **Database** | PostgreSQL / Supabase, `postgres.js`, Drizzle ORM, `btree_gist` extension |
| **Voice AI** | Retell AI (`retell-client-js-sdk` v3, `retell-sdk`, `gpt-6-luna`) |
| **Integrations** | Google Calendar API (`google-auth-library` offline OAuth2) |
| **Testing** | Vitest (78 unit/integration tests with wire-protocol isolation) |

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/Deekshith-j/Hello-Doc-voice-agent.git
cd Hello-Doc-voice-agent
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Key environment variables:

```env
# Database (Supabase PostgreSQL pooled or direct URL)
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:[PORT]/postgres

# Retell AI
RETELL_API_KEY=your_retell_api_key
RETELL_AGENT_ID=your_retell_agent_id
RETELL_LLM_ID=your_retell_llm_id

# Public URL (for registering Retell webhook & tool URLs)
PUBLIC_BASE_URL=https://docto-agent.vercel.app

# Optional Calendar Sync & Background Reconciliation
CRON_SECRET=your_random_32_character_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REFRESH_TOKEN=your_offline_refresh_token
```

### 3. Database Migrations & Seed

```bash
npm run db:migrate
npm run db:seed -- --target=main
```

### 4. Provision Retell Agent

To configure the LLM prompt, voice, and all 7 tool endpoints on Retell:

```bash
npm run retell:setup
```

### 5. Run Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the Live Call workspace.

---

## Quality Verification

Run the verification suite:

```bash
# Typecheck TypeScript
npm run typecheck

# Lint (zero warnings allowed)
npm run lint

# Run all 78 unit & integration tests
npm test

# Run tool contract evaluation harness
npm run eval

# Production build verification
npm run build
```

---

## Known Limitations

1. **Calendar write path unverified against a live calendar**: Google Calendar sync is validated against mock adapters and unit tests, but the live OAuth refresh token write path has not been verified against an active production Google Workspace enterprise calendar.
2. **Public demo with synthetic data only**: The dashboard and web call interface operate purely on synthetic test fixtures and seed data. It is not HIPAA-certified and must not be connected to real clinical EHR records or live PHI.
3. **DOB plus name is weak identity verification**: Verification relies solely on full name and date of birth. While common in outpatient phone intake, it offers no cryptographic or multi-factor authentication (e.g. SMS OTP or carrier ANI verification) and can be spoofed by acquaintances.
4. **Per-instance web-call rate limit**: Browser demo calls on `/api/retell/web-call` are throttled via an in-memory rate limiter per serverless instance rather than a globally coordinated Redis cluster, meaning concurrent traffic spanning multiple edge instances could exceed intended rate caps.
5. **Small eval suite (real numbers)**: Evaluated against a 5-scenario smoke suite (`book-exist-01`, `book-exist-02`, `reg-new-01`, `reg-new-02`, `resched-01`) with N=1, achieving an **80% overall pass rate** (4/5 passed; 5/5 or 100% database invariant satisfaction) at a total run cost of **$0.0204 USD** across **397,036 tokens** with **957 ms median turn latency**. The complete 30-scenario matrix requires elevated multi-model API rate quotas.
6. **Hardcoded emergency number**: The emergency escalation number (`911`) is hardcoded into the agent prompt rather than dynamically localized to regional dispatch centers (e.g. `999` in the UK, `112` in the EU) based on caller telecom ANI or clinic geolocation.
