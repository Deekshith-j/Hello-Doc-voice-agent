// Pins the Google Calendar HTTP contract: retries, idempotent writes, and failure handling.
// A scripted fetcher replaces the network so every response sequence is deterministic.
import { describe, expect, it } from "vitest";

import type { CalendarBooking } from "@/domain/availability";
import {
  GoogleCalendarError,
  GoogleCalendarSource,
  googleEventId,
} from "@/integrations/google-calendar-source";

const APPOINTMENT_ID = "30000000-0000-4000-8000-000000000001";
const CALENDAR_ID = "clinic@example.com";
const booking: CalendarBooking = {
  appointmentId: APPOINTMENT_ID,
  doctorId: "10000000-0000-4000-8000-000000000001",
  externalEventId: null,
  time: {
    start: new Date("2027-01-12T14:00:00.000Z"),
    end: new Date("2027-01-12T14:30:00.000Z"),
  },
};

interface RecordedCall {
  body: unknown;
  method: string;
  url: string;
}

describe("Google Calendar source", () => {
  it("parses free/busy intervals for the doctor's calendar", async () => {
    const { source } = scripted([
      json(200, {
        calendars: {
          [CALENDAR_ID]: {
            busy: [
              { start: "2027-01-12T14:00:00Z", end: "2027-01-12T15:00:00Z" },
            ],
          },
        },
      }),
    ]);
    const result = await source.getBusyTimes(booking.doctorId, booking.time);
    expect(result.intervals).toEqual([
      {
        start: new Date("2027-01-12T14:00:00Z"),
        end: new Date("2027-01-12T15:00:00Z"),
      },
    ]);
  });

  it("treats a per-calendar error as unusable rather than empty", async () => {
    const { source } = scripted([
      json(200, {
        calendars: {
          [CALENDAR_ID]: { busy: [], errors: [{ reason: "notFound" }] },
        },
      }),
    ]);
    await expect(
      source.getBusyTimes(booking.doctorId, booking.time),
    ).rejects.toBeInstanceOf(GoogleCalendarError);
  });

  it("retries transient failures before succeeding", async () => {
    const { calls, source } = scripted([
      json(503, {}),
      json(429, {}),
      json(200, { id: googleEventId(APPOINTMENT_ID) }),
    ]);
    await source.upsertBooking(booking);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a permanent client error", async () => {
    const { calls, source } = scripted([json(403, {})]);
    await expect(source.upsertBooking(booking)).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toHaveLength(1);
  });

  it("creates events with a deterministic ID and no patient details", async () => {
    const { calls, source } = scripted([
      json(200, { id: googleEventId(APPOINTMENT_ID) }),
    ]);
    const result = await source.upsertBooking(booking);
    expect(result.externalEventId).toBe(
      `docto${APPOINTMENT_ID.replaceAll("-", "")}`,
    );
    expect(calls[0]?.body).toMatchObject({
      id: result.externalEventId,
      summary: "Clinic appointment",
    });
  });

  it("moves and restores an existing event when insert conflicts", async () => {
    const eventId = googleEventId(APPOINTMENT_ID);
    const { calls, source } = scripted([
      json(409, {}),
      json(200, { id: eventId }),
    ]);
    await source.upsertBooking(booking);
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      body: {
        status: "confirmed",
        start: { dateTime: "2027-01-12T14:00:00.000Z" },
      },
    });
    expect(calls[1]?.url).toContain(`/events/${eventId}`);
  });

  it("treats an already-deleted event as cancelled", async () => {
    const { source } = scripted([json(410, {})]);
    await expect(source.cancelBooking(booking)).resolves.toBeUndefined();
  });
});

function scripted(responses: Response[]) {
  const calls: RecordedCall[] = [];
  const source = new GoogleCalendarSource({
    getAccessToken: async () => "token",
    resolveCalendarId: async () => CALENDAR_ID,
    sleep: async () => {},
    fetcher: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected extra request.");
      return next;
    },
  });
  return { calls, source };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}
