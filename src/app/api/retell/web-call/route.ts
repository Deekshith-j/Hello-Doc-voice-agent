// Starts a browser web call and returns a short-lived access token.
// The Retell API key never leaves the server; only the per-call token reaches the browser.
import { areWebCallsEnabled, getRetellConfig } from "@/config/environment";
import { RetellApi, RetellApiError } from "@/integrations/retell/retell-api";
import { getToolRuntime } from "@/server/tool-runtime";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  if (!areWebCallsEnabled()) {
    return Response.json(
      {
        ok: false,
        code: "web_calls_disabled",
        message: "Web calls are temporarily disabled.",
      },
      { status: 503 },
    );
  }

  const config = getRetellConfig();
  if (!config?.agentId) {
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
