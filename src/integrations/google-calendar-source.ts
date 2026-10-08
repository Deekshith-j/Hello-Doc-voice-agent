// Reads Google Calendar busy windows and mirrors appointment lifecycle changes.
// Deterministic event IDs make every write safe to replay after ambiguous network failures.
import { z } from "zod";

import type {
  AvailabilitySource,
  BusyTimeResult,
  CalendarBooking,
  CalendarBookingResult,
  TimeInterval,
} from "@/domain/availability";

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const EXTERNAL_CALL_TIMEOUT_MS = 4_000;
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 150;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;

const googleDateTime = z.iso.datetime({ offset: true });

const freeBusySchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: googleDateTime, end: googleDateTime })),
      errors: z.array(z.unknown()).optional(),
    }),
  ),
});

const eventSchema = z.object({ id: z.string().min(5) });

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

export interface GoogleCalendarDependencies {
  fetcher?: typeof fetch;
  getAccessToken: () => Promise<string>;
  resolveCalendarId: (doctorId: string) => Promise<string | null>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GoogleCalendarSource implements AvailabilitySource {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: GoogleCalendarDependencies) {
    this.fetcher = dependencies.fetcher ?? fetch;
    this.sleep = dependencies.sleep ?? wait;
  }

  async getBusyTimes(
    doctorId: string,
    window: TimeInterval,
  ): Promise<BusyTimeResult> {
    const calendarId = await this.requireCalendarId(doctorId);
    const response = await this.request("/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: window.start.toISOString(),
        timeMax: window.end.toISOString(),
        timeZone: "UTC",
        items: [{ id: calendarId }],
      }),
    });
    const payload = freeBusySchema.parse(await response.json());
    const calendar = payload.calendars[calendarId];
    if (!calendar || calendar.errors?.length)
      throw new GoogleCalendarError(
        "Google Calendar did not return usable availability.",
      );
    return {
      intervals: calendar.busy.map(toInterval),
      retrievedAt: new Date(),
    };
  }

  async upsertBooking(
    booking: CalendarBooking,
  ): Promise<CalendarBookingResult> {
    const calendarId = await this.requireCalendarId(booking.doctorId);
    const eventId =
      booking.externalEventId ?? googleEventId(booking.appointmentId);
    const inserted = await this.request(
      calendarEventsPath(calendarId),
      { method: "POST", body: JSON.stringify(eventBody(booking, eventId)) },
      [HTTP_CONFLICT],
    );
    if (inserted.status !== HTTP_CONFLICT)
      return { externalEventId: eventSchema.parse(await inserted.json()).id };

    // The event exists from an earlier attempt or booking; move it and restore it if deleted.
    const patched = await this.request(calendarEventPath(calendarId, eventId), {
      method: "PATCH",
      body: JSON.stringify({
        status: "confirmed",
        ...eventTimes(booking.time),
      }),
    });
    return { externalEventId: eventSchema.parse(await patched.json()).id };
  }

  async cancelBooking(booking: CalendarBooking): Promise<void> {
    const calendarId = await this.requireCalendarId(booking.doctorId);
    const eventId =
      booking.externalEventId ?? googleEventId(booking.appointmentId);
    // Missing or already-deleted events mean the calendar already matches Postgres.
    await this.request(
      calendarEventPath(calendarId, eventId),
      { method: "DELETE" },
      [HTTP_NOT_FOUND, HTTP_GONE],
    );
  }

  private async requireCalendarId(doctorId: string): Promise<string> {
    const calendarId = await this.dependencies.resolveCalendarId(doctorId);
    if (!calendarId)
      throw new GoogleCalendarError(
        "The doctor does not have a Google Calendar configured.",
      );
    return calendarId;
  }

  private async request(
    path: string,
    init: RequestInit,
    acceptedErrors: readonly number[] = [],
  ): Promise<Response> {
    const token = z
      .string()
      .min(1)
      .parse(await this.dependencies.getAccessToken());
    const response = await this.fetchWithRetry(
      `${GOOGLE_CALENDAR_BASE_URL}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (!response.ok && !acceptedErrors.includes(response.status)) {
      throw new GoogleCalendarError(
        `Google Calendar request failed with status ${response.status}.`,
        response.status,
      );
    }
    return response;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      try {
        const response = await this.fetcher(url, {
          ...init,
          signal: AbortSignal.timeout(EXTERNAL_CALL_TIMEOUT_MS),
        });
        if (!RETRYABLE_STATUS_CODES.has(response.status) || isLastAttempt)
          return response;
        // Release the unused body so the connection can be reused for the retry.
        await response.body?.cancel();
      } catch (error) {
        if (isLastAttempt) throw error;
      }
      await this.sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventBody(booking: CalendarBooking, eventId: string) {
  // The summary stays generic: calendar viewers do not need patient identity or reason.
  return {
    id: eventId,
    summary: "Clinic appointment",
    description: `Docto appointment ${booking.appointmentId}`,
    transparency: "opaque",
    extendedProperties: {
      private: { doctoAppointmentId: booking.appointmentId },
    },
    ...eventTimes(booking.time),
  };
}

function eventTimes(time: TimeInterval) {
  return {
    start: { dateTime: time.start.toISOString() },
    end: { dateTime: time.end.toISOString() },
  };
}

export function googleEventId(appointmentId: string): string {
  // Google event IDs allow base32hex (a–v, 0–9); a UUID's hex digits and "docto" all qualify.
  return `docto${appointmentId.replaceAll("-", "").toLowerCase()}`;
}

function calendarEventsPath(calendarId: string): string {
  return `/calendars/${encodeURIComponent(calendarId)}/events`;
}

function calendarEventPath(calendarId: string, eventId: string): string {
  return `${calendarEventsPath(calendarId)}/${encodeURIComponent(eventId)}`;
}

function toInterval(value: { start: string; end: string }): TimeInterval {
  return { start: new Date(value.start), end: new Date(value.end) };
}
