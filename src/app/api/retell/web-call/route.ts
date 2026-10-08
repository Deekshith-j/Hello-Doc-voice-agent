// Starts a browser web call and returns a short-lived access token.
// The Retell API key never leaves the server; only the per-call token reaches the browser.
import {
  areWebCallsEnabled,
  getClinicSettings,
  getRetellConfig,
} from "@/config/environment";
import { RetellApi, RetellApiError } from "@/integrations/retell/retell-api";
import { getToolRuntime } from "@/server/tool-runtime";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  const config = getRetellConfig();
  const hasApiKey = Boolean(config?.apiKey);
  const hasAgentId = Boolean(config?.agentId);

  if (!areWebCallsEnabled()) {
    console.warn(
      JSON.stringify({
        event: "web_call_attempt",
        status: 503,
        reason: "web_calls_disabled",
        hasApiKey,
        hasAgentId,
      }),
    );
    return Response.json(
      {
        ok: false,
        code: "web_calls_disabled",
        message: "Web calls are temporarily disabled.",
      },
      { status: 503 },
    );
  }

  if (!config?.agentId) {
    console.warn(
      JSON.stringify({
        event: "web_call_attempt",
        status: 503,
        reason: "retell_not_configured",
        hasApiKey,
        hasAgentId: false,
      }),
    );
    return Response.json(
      {
        ok: false,
        code: "retell_not_configured",
        message: "Voice agent is not configured.",
      },
      { status: 503 },
    );
  }

  const forwarded = request.headers.get("x-forwarded-for");
  const firstIp = forwarded?.split(",")[0]?.trim();
  const clientIp = firstIp || request.headers.get("x-real-ip") || "127.0.0.1";

  const now = new Date();
  const runtime = getToolRuntime();

  // 1. IP rate limit: max 5 calls per IP per hour
  const ipLimit = await runtime.consumeRateLimit(
    `web_call:ip:${clientIp}`,
    now,
    { maxRequests: 5, windowMs: ONE_HOUR_MS },
  );
  if (!ipLimit.allowed) {
    console.warn(
      JSON.stringify({
        event: "web_call_rate_limited",
        limitType: "ip",
        status: 429,
        hasApiKey,
        hasAgentId,
      }),
    );
    return Response.json(
      {
        ok: false,
        code: "rate_limited",
        message:
          "You have reached the limit of 5 demo calls per hour. Please try again later.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(ipLimit.retryAfterSeconds) },
      },
    );
  }

  // 2. Global rate limit: max 30 calls per day overall
  const globalLimit = await runtime.consumeRateLimit(
    "web_call:global",
    now,
    { maxRequests: 30, windowMs: ONE_DAY_MS },
  );
  if (!globalLimit.allowed) {
    console.warn(
      JSON.stringify({
        event: "web_call_rate_limited",
        limitType: "global",
        status: 429,
        hasApiKey,
        hasAgentId,
      }),
    );
    return Response.json(
      {
        ok: false,
        code: "rate_limited",
        message:
          "The clinic demo has reached its daily limit of 30 calls. Please try again tomorrow.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(globalLimit.retryAfterSeconds) },
      },
    );
  }

  try {
    const clinicSettings = getClinicSettings();
    const session = await new RetellApi(config.apiKey).createWebCall(
      config.agentId,
      { source: "dashboard" },
      {
        clinic_name: clinicSettings.name,
        emergency_number: "911",
        clinic_timezone: clinicSettings.timeZone,
        clinic_time_zone: clinicSettings.timeZone,
      },
    );
    console.info(
      JSON.stringify({
        event: "web_call_created",
        status: 200,
        callId: session.callId,
        transport: session.transport,
        hasApiKey,
        hasAgentId,
      }),
    );
    return Response.json({
      ok: true,
      access_token: session.accessToken,
      call_id: session.callId,
      transport: session.transport,
      ice_servers: session.iceServers,
      created_at: Date.now(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "web_call",
        outcome: "failed",
        status: error instanceof RetellApiError ? error.status : 502,
        hasApiKey,
        hasAgentId,
        error: error instanceof Error ? error.name : "unknown",
        errorMessage: error instanceof Error ? error.message : "unknown",
      }),
    );
    return Response.json(
      {
        ok: false,
        code: "retell_unavailable",
        message:
          error instanceof RetellApiError
            ? `Retell API error (${error.status})`
            : "Retell didn't accept the call. Try again shortly.",
      },
      { status: 502 },
    );
  }
}
