// Retries calendar writes that failed after Postgres committed the appointment.
// Vercel Cron calls this with CRON_SECRET; without a configured secret the route stays closed.
import { timingSafeEqual } from "node:crypto";

import { getCronSecret } from "@/config/environment";
import { getToolRuntime } from "@/server/tool-runtime";

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization")))
    return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });

  const summary = await getToolRuntime().calendarSync.reconcile();
  console.info(JSON.stringify({ event: "calendar_reconcile", ...summary }));
  return Response.json({ ok: true, ...summary });
}

function isAuthorized(header: string | null): boolean {
  const secret = getCronSecret();
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  // Constant-time comparison avoids leaking how much of the secret matched.
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
