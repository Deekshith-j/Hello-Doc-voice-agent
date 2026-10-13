// WHAT: Web call session initiator issuing ephemeral access tokens for browser demo calls.
// WHY: Authenticates browser sessions against Retell AI (/v2/create-web-call) without exposing
// the master Retell API key to client browsers, enforcing per-IP and global daily demo rate limits.
import {
  areWebCallsEnabled,
  getClinicSettings,
  getRetellConfig,
} from "@/config/environment";
import { RetellApi, RetellApiError } from "@/integrations/retell/retell-api";
import { getToolRuntime } from "@/server/tool-runtime";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface CallContext {
  hasAgentId: boolean;
  hasApiKey: boolean;
}

export async function POST(request: Request): Promise<Response> {
  const config = getRetellConfig();
  const context: CallContext = {
    hasApiKey: Boolean(config?.apiKey),
    hasAgentId: Boolean(config?.agentId),
  };

  const configErrorResponse = validateWebCallConfig(config, context);
  if (configErrorResponse) return configErrorResponse;

  const clientIp = getClientIp(request);
  const now = new Date();
  const runtime = getToolRuntime();

  const ipRateLimitResponse = await checkIpRateLimit(
    runtime,
    clientIp,
    now,
    context,
  );
  if (ipRateLimitResponse) return ipRateLimitResponse;

  const globalRateLimitResponse = await checkGlobalRateLimit(
    runtime,
    now,
    context,
  );
  if (globalRateLimitResponse) return globalRateLimitResponse;

  return createWebCallSession(
    { apiKey: config!.apiKey, agentId: config!.agentId! },
    context,
  );
}

function validateWebCallConfig(
  config: ReturnType<typeof getRetellConfig>,
  context: CallContext,
): Response | null {
  if (!areWebCallsEnabled()) {
    console.warn(
      JSON.stringify({
        event: "web_call_attempt",
        status: 503,
        reason: "web_calls_disabled",
        ...context,
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
        hasApiKey: context.hasApiKey,
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

  return null;
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const firstIp = forwarded?.split(",")[0]?.trim();
  return firstIp || request.headers.get("x-real-ip") || "127.0.0.1";
}

async function checkIpRateLimit(
  runtime: ReturnType<typeof getToolRuntime>,
  clientIp: string,
  now: Date,
  context: CallContext,
): Promise<Response | null> {
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
        ...context,
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

  return null;
}

async function checkGlobalRateLimit(
  runtime: ReturnType<typeof getToolRuntime>,
  now: Date,
  context: CallContext,
): Promise<Response | null> {
  const globalLimit = await runtime.consumeRateLimit("web_call:global", now, {
    maxRequests: 30,
    windowMs: ONE_DAY_MS,
  });

  if (!globalLimit.allowed) {
    console.warn(
      JSON.stringify({
        event: "web_call_rate_limited",
        limitType: "global",
        status: 429,
        ...context,
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

  return null;
}

async function createWebCallSession(
  config: { agentId: string; apiKey: string },
  context: CallContext,
): Promise<Response> {
  try {
    const clinicSettings = getClinicSettings();
    const session = await new RetellApi(config.apiKey).createWebCall(
      config.agentId,
      { source: "dashboard" },
      {
        clinic_name: clinicSettings.name,
        emergency_number: "911",
        current_time: new Intl.DateTimeFormat("en-US", {
          timeZone: clinicSettings.timeZone,
          dateStyle: "full",
          timeStyle: "short",
        }).format(new Date()),
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
        ...context,
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
        ...context,
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
