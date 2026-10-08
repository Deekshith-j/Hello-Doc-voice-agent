<!-- Documents the real-calendar contract, setup needs, and failure behavior. -->
<!-- This exists separately from README so operators can review calendar risk in one place. -->

# Google Calendar integration

Docto reads busy intervals through Google Calendar API v3 `freeBusy.query` and mirrors bookings through event insert, patch, and delete operations. PostgreSQL remains the system of record.

## Required configuration

- An OAuth web client ID and client secret.
- An offline refresh token authorized for `https://www.googleapis.com/auth/calendar`.
- A writable Google Calendar ID stored on each doctor row with `calendar_provider = 'google'`.
- The authenticated Google user must have write access to every configured calendar.

Google recommends offline OAuth access when a server must call APIs without the user present. Event IDs are derived from appointment UUIDs and restricted to Google’s documented base32hex character set, preventing duplicate event creation after an ambiguous timeout.

## Failure policy

- **Free/busy times out, is stale, or returns an error:** fail closed. The voice agent says live availability cannot be confirmed and asks the caller to try again shortly.
- **Postgres booking succeeds but event creation fails:** keep the appointment, set calendar sync to `failed`, and say the clinic recorded the appointment but calendar synchronization is pending.
- **Reschedule or cancellation sync fails:** keep the Postgres change, mark sync failed, and retry out of band. Repeated calendar writes use the same external event ID.
- **Retrying:** `GET /api/internal/calendar-sync` with `Authorization: Bearer $CRON_SECRET` replays up to 25 `pending`/`failed` appointments untouched for 60 seconds. Booked rows are upserted (insert, or patch on 409); cancelled rows are deleted (404 and 410 count as done). Without `CRON_SECRET` the route always returns 401.
- **Google returns HTTP 429 or a transient 5xx:** retry up to three times with a four-second per-attempt timeout. Permanent 4xx responses are not retried.
- **No calendar is configured:** use Postgres availability only. If a calendar ID is configured but credentials are absent, fail closed rather than treating the calendar as empty.

## Authoritative references

- [Free/busy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Create events](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Calendar API errors](https://developers.google.com/workspace/calendar/api/guides/errors)
- [OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
