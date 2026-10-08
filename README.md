# Docto — AI Clinic Appointment Voice Agent

Docto is a production-grade, voice-driven clinic appointment front desk application. It integrates [Retell AI](https://retellai.com) for natural conversational voice interaction, PostgreSQL / [Supabase](https://supabase.com) with database-enforced concurrency invariants against double-booking, and Google Calendar for two-way schedule synchronization.

---

## Architecture Overview

```
                      ┌──────────────────────┐
                      │    Patient / Caller  │
                      └──────────┬───────────┘
                                 │ Voice (WebRTC / Phone)
                                 ▼
                      ┌──────────────────────┐
                      │    Retell AI Voice   │
                      └──────────┬───────────┘
                                 │ HTTP Function Tools + Signed Webhook
                                 ▼
                      ┌──────────────────────┐
                      │   Next.js API Routes │
                      │   (/api/tools/*)     │
                      └─────┬──────────┬─────┘
                            │          │
         Postgres SQL /     │          │ Offline OAuth2
         GiST Constraints   │          │ Free/Busy + Upsert
                            ▼          ▼
            ┌─────────────────┐      ┌─────────────────┐
            │ Supabase / PG   │      │ Google Calendar │
            │ (Source of Truth│      │ (External Sync) │
            └─────────────────┘      └─────────────────┘
```

### Core Invariants & Design

1. **Database as Single Source of Truth**: Postgres GiST range exclusion constraints (`appointments_no_doctor_overlap`) prevent overlapping bookings at the database engine level, eliminating race conditions even under concurrent callers.
2. **Idempotent Operations**: All tool actions (`book-appointment`, `reschedule-appointment`, `cancel-appointment`) require caller idempotency keys and return existing bookings on network retries.
3. **Resilient Calendar Reconciliation**: If an external calendar provider API drops or throttles, the Postgres transaction commits with `calendar_sync_status = 'pending'`, and a background reconciliation cron route (`/api/internal/calendar-sync`) retries until synchronized.
4. **Restrained Front-Desk Dashboard**: A clean operator interface built with Geist typography, semantic tokens, dark/light theme persistence, live web call stage, real-time tool audit timeline, and agenda review.

---

## Technology Stack

- **Framework**: Next.js 16 (App Router, Server Actions, Route Handlers)
- **Database & Backend**: PostgreSQL / Supabase with `postgres.js` and Drizzle ORM schemas
- **Voice Agent Engine**: Retell AI (`retell-client-js-sdk` v3)
- **External Calendars**: Google Calendar API via `google-auth-library`
- **Testing & Evals**: Vitest (wire-protocol Postgres tests) & Custom Tool Contract Eval Suite
- **Styling**: Tailwind CSS v4 with custom semantic tokens and animations

---

## Getting Started Locally

### 1. Prerequisites

- Node.js >= 24.0.0
- npm >= 10.0.0

### 2. Install Dependencies

```bash
npm install
```

### 3. Local Database Setup

Run the embedded PostgreSQL instance (requires zero external setup):

```bash
npm run db:local
```

This boots an embedded PostgreSQL instance on port `54329`, runs migrations, and seeds synthetic demo doctors and patients into `.pglite/`.

Copy the printed connection URL into `.env.local`:

```bash
DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Supabase Database Setup

When connecting Docto to Supabase:

1. **Create a Supabase Project**: Go to [supabase.com](https://supabase.com) and create a new project.
2. **Get Connection String**: In your Supabase Dashboard:
   - Go to **Project Settings** → **Database** → **Connection string**.
   - Select **URI** (Transaction pooler on port 6543 or Session pooler on port 5432).
   - Copy the URI and replace `[YOUR-PASSWORD]` with your database password.
3. **Set Environment Variable**:
   ```env
   DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
   ```
4. **Run Migrations & Seed**:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
   The migrations will automatically enable `btree_gist` and create the doctors, patients, appointments, availability rules, and call logs.

---

## Retell AI Configuration

1. **Obtain API Key**:
   - Create an account on [retellai.com](https://retellai.com).
   - Generate an API Key with the **webhook badge enabled** (used to sign incoming tool requests and webhooks).
2. **Set Environment Variables**:
   ```env
   RETELL_API_KEY=your_retell_api_key
   PUBLIC_BASE_URL=https://your-domain.vercel.app
   ```
3. **Automated Agent Setup**:
   Once deployed or tunneled (e.g. ngrok), run:

   ```bash
   npm run retell:setup
   ```

   This automatically provisions the Retell LLM with all 7 clinic tools (`list_doctors`, `find_patient`, `check_availability`, `book_appointment`, `list_patient_appointments`, `reschedule_appointment`, `cancel_appointment`), system prompts, and sets your webhook endpoint.

4. Add the output `RETELL_AGENT_ID` and `RETELL_LLM_ID` to `.env.local` or Vercel environment variables.

---

## Google Calendar Integration (Optional)

1. In Google Cloud Console, enable the **Google Calendar API**.
2. Create an **OAuth 2.0 Client ID** (Web Application).
3. Authorize offline access to obtain a refresh token with `https://www.googleapis.com/auth/calendar` scope.
4. Set in your environment:
   ```env
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   GOOGLE_REFRESH_TOKEN=your_offline_refresh_token
   ```
5. Doctors in the database with `calendar_provider = 'google'` and an `external_calendar_id` (Google Calendar ID / email) will automatically have availability checked and appointments synced.

---

## Quality Verification Commands

Run the full verification suite before committing:

```bash
# Type-check TypeScript & generate route types
npm run typecheck

# ESLint inspection (zero warnings allowed)
npm run lint

# Prettier code formatting check
npm run format:check

# Unit & integration wire-protocol database tests (65 tests)
npm test

# Run tool contract evaluation harness
npm run eval

# Next.js production build verification
npm run build
```

---

## Vercel Deployment

1. Push your repository to GitHub.
2. Import the project into Vercel.
3. Configure the Environment Variables in Vercel:
   - `DATABASE_URL`: Supabase PostgreSQL pooled connection URL.
   - `DASHBOARD_PASSWORD`: Minimum 12 character passphrase for operator sign-in.
   - `SESSION_SECRET`: 32+ character random hex string (`openssl rand -hex 32`).
   - `CRON_SECRET`: 32+ character random string for the calendar sync cron route.
   - `PUBLIC_BASE_URL`: `https://<your-project>.vercel.app`
   - `RETELL_API_KEY`: Retell API key.
   - `RETELL_AGENT_ID`: ID returned from `npm run retell:setup`.
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (optional).
4. Deploy! `vercel.json` will automatically schedule `/api/internal/calendar-sync` to run every 10 minutes.
