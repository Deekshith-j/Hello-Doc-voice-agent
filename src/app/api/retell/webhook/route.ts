// Records Retell call lifecycle events: start, end with transcript, and post-call analysis.
// Every write is idempotent, so Retell's retries after a slow response are harmless.
import { getPostgresErrorCode } from "@/application/errors";
import {
  retellWebhookSchema,
  toCallAnalyzed,
  toCallEnded,
  toCallStarted,
} from "@/integrations/retell/webhook-events";
import {
  authenticateRetellRequest,
  retellAuthFailure,
} from "@/server/retell-request";
import { getToolRuntime } from "@/server/tool-runtime";

export async function POST(request: Request): Promise<Response> {
  const runtime = getToolRuntime();
  const rawBody = await request.text();
  const authFailure = retellAuthFailure(
    authenticateRetellRequest(
      rawBody,
      request.headers.get("x-retell-signature"),
      runtime.retellSigningKey,
    ),
  );
  if (authFailure) return authFailure;

  const parsed = retellWebhookSchema.safeParse(safeJson(rawBody));
  if (!parsed.success)
    return Response.json(
      { ok: false, code: "invalid_payload" },
      { status: 400 },
    );

  const { call, event } = parsed.data;
  const now = new Date();
  try {
    if (event === "call_started")
      await runtime.callLog.recordCallStarted(toCallStarted(call, now));
    else if (event === "call_ended")
      await runtime.callLog.recordCallEnded(toCallEnded(call, now));
    else if (event === "call_analyzed")
      await runtime.callLog.recordCallAnalyzed(toCallAnalyzed(call));
  } catch (error) {
    // A 5xx asks Retell to retry, which is safe because every write is an upsert.
    console.error(
      JSON.stringify({
        event: "retell_webhook",
        outcome: "failed",
        webhook_event: event,
        call_id: call.call_id,
        error: error instanceof Error ? error.name : "unknown",
        sqlstate: getPostgresErrorCode(error),
      }),
    );
    return Response.json({ ok: false }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}

function safeJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
