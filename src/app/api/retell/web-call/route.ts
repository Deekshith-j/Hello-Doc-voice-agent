// Starts a browser web call for a signed-in operator and returns a short-lived access token.
// The Retell API key never leaves the server; only the per-call token reaches the browser.
import { getRetellConfig } from "@/config/environment";
import { RetellApi, RetellApiError } from "@/integrations/retell/retell-api";
import { operatorApiGuard } from "@/server/dashboard-session";
import { getToolRuntime } from "@/server/tool-runtime";

export async function POST(): Promise<Response> {
  const unauthorized = await operatorApiGuard();
  if (unauthorized) return unauthorized;

  const config = getRetellConfig();
  if (!config?.agentId)
    return Response.json(
      { ok: false, code: "retell_not_configured" },
      { status: 503 },
    );

  const limit = await getToolRuntime().consumeRateLimit("web_call:dashboard");
  if (!limit.allowed)
    return Response.json(
      { ok: false, code: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );

  try {
    const session = await new RetellApi(config.apiKey).createWebCall(
      config.agentId,
      { source: "dashboard" },
    );
    return Response.json({
      ok: true,
      access_token: session.accessToken,
      call_id: session.callId,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "web_call",
        outcome: "failed",
        status: error instanceof RetellApiError ? error.status : undefined,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return Response.json(
      { ok: false, code: "retell_unavailable" },
      { status: 502 },
    );
  }
}
