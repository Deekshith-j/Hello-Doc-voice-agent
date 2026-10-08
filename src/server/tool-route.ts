// Provides one hardened HTTP adapter for every Retell custom-function route.
// Signature checks, rate limits, validation, call logging, and errors stay identical across tools.
import { randomUUID } from "node:crypto";

import { after } from "next/server";
import { z } from "zod";

import type { AppointmentToolService } from "@/application/appointment-tool-service";
import { getPostgresErrorCode, ToolBusinessError } from "@/application/errors";
import { type ToolResponse, toolFailure } from "@/application/tool-response";

import { authenticateRetellRequest, retellAuthFailure } from "./retell-request";
import { getToolRuntime, type ToolRuntime } from "./tool-runtime";

const requestIdSchema = z.uuid();
const clientAddressSchema = z.string().trim().min(1).max(100);
// Retell wraps arguments as { name, call, args } unless "args only" is enabled.
const retellEnvelopeSchema = z.object({
  args: z.unknown(),
  call: z.object({ call_id: z.string().min(1).max(200) }),
});

type RouteRuntime = Pick<
  ToolRuntime,
  "callLog" | "consumeRateLimit" | "retellSigningKey" | "service"
>;

export interface ToolContext {
  callId: string | null;
}

export interface ToolDefinition<TSchema extends z.ZodType> {
  execute: (
    service: AppointmentToolService,
    input: z.infer<TSchema>,
    context: ToolContext,
  ) => Promise<ToolResponse>;
  // find_patient links the call to the verified patient so operators see who called.
  linksVerifiedPatient?: boolean;
  name: string;
  schema: TSchema;
}

export function createToolRoute<TSchema extends z.ZodType>(
  tool: ToolDefinition<TSchema>,
  runtimeProvider: () => RouteRuntime = getToolRuntime,
) {
  return async function POST(request: Request): Promise<Response> {
    const startedAt = performance.now();
    const requestId = parseRequestId(request.headers.get("x-request-id"));
    let callId: string | null = null;
    try {
      const runtime = runtimeProvider();
      const rawBody = await request.text();
      const authFailure = retellAuthFailure(
        authenticateRetellRequest(
          rawBody,
          request.headers.get("x-retell-signature"),
          runtime.retellSigningKey,
        ),
      );
      if (authFailure) return withRequestId(authFailure, requestId);

      const { args, providerCallId } = unwrap(parseJson(rawBody));
      callId = providerCallId;
      const result = await runTool(tool, runtime, request, args, callId);
      await recordToolCall(runtime, tool, {
        args,
        callId,
        requestId,
        result,
        startedAt,
      });
      logToolCall(
        tool.name,
        requestId,
        startedAt,
        result.ok ? "completed" : "rejected",
        result.code,
      );

      if (
        result.code.endsWith("_calendar_pending") &&
        result.data &&
        typeof result.data === "object" &&
        "appointment_id" in result.data
      ) {
        const appointmentId = String(
          (result.data as { appointment_id: unknown }).appointment_id,
        );
        try {
          after(async () => {
            try {
              await runtime.service.retryCalendarSync(appointmentId);
            } catch (error) {
              console.warn(
                JSON.stringify({
                  event: "calendar_retry_failed",
                  request_id: requestId,
                  appointment_id: appointmentId,
                  error: error instanceof Error ? error.name : "unknown",
                }),
              );
            }
          });
        } catch {
          // If executed outside of a request lifecycle (e.g. tests), fall back cleanly
          void runtime.service
            .retryCalendarSync(appointmentId)
            .catch((error) => {
              console.warn(
                JSON.stringify({
                  event: "calendar_retry_failed",
                  request_id: requestId,
                  appointment_id: appointmentId,
                  error: error instanceof Error ? error.name : "unknown",
                }),
              );
            });
        }
      }

      return withRequestId(Response.json(result), requestId);
    } catch (error) {
      return handleRouteError(error, tool.name, requestId, startedAt);
    }
  };
}

async function runTool<TSchema extends z.ZodType>(
  tool: ToolDefinition<TSchema>,
  runtime: RouteRuntime,
  request: Request,
  args: unknown,
  callId: string | null,
): Promise<ToolResponse> {
  // Retell calls come from shared infrastructure, so the limit follows the call, not the IP.
  const limitKey = callId
    ? `${tool.name}:call:${callId}`
    : `${tool.name}:ip:${parseClientAddress(request.headers.get("x-forwarded-for"))}`;
  const limit = await runtime.consumeRateLimit(limitKey);
  if (!limit.allowed)
    return toolFailure(
      "rate_limited",
      "I'm receiving requests too quickly. Please wait a moment and try again.",
    );

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success)
    return toolFailure(
      "invalid_request",
      "Some details were missing or invalid. Please check them and try again.",
      { issues: parsed.error.issues.map((issue) => describeIssue(issue)) },
    );
  try {
    return await tool.execute(runtime.service, parsed.data, { callId });
  } catch (error) {
    // Expected business failures are speakable outcomes, not transport errors.
    if (error instanceof ToolBusinessError)
      return toolFailure(error.code, error.message);
    throw error;
  }
}

async function recordToolCall<TSchema extends z.ZodType>(
  runtime: RouteRuntime,
  tool: ToolDefinition<TSchema>,
  entry: {
    args: unknown;
    callId: string | null;
    requestId: string;
    result: ToolResponse;
    startedAt: number;
  },
): Promise<void> {
  if (!entry.callId) return;
  try {
    await runtime.callLog.recordToolCall({
      providerCallId: entry.callId,
      requestId: entry.requestId,
      toolName: tool.name,
      arguments: sanitizeArguments(entry.args ?? {}),
      result: entry.result,
      latencyMs: Math.round(performance.now() - entry.startedAt),
      verifiedPatientId: tool.linksVerifiedPatient
        ? verifiedPatientId(entry.result)
        : null,
    });
  } catch (error) {
    // The caller's request already succeeded; a lost audit row must not turn it into a failure.
    console.error(
      JSON.stringify({
        event: "tool_call_log",
        outcome: "failed",
        tool: tool.name,
        request_id: entry.requestId,
        error: error instanceof Error ? error.name : "unknown",
        sqlstate: getPostgresErrorCode(error),
      }),
    );
  }
}

function unwrap(body: unknown): {
  args: unknown;
  providerCallId: string | null;
} {
  const envelope = retellEnvelopeSchema.safeParse(body);
  return envelope.success
    ? { args: envelope.data.args, providerCallId: envelope.data.call.call_id }
    : { args: body, providerCallId: null };
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new InvalidJsonError();
  }
}

function sanitizeArguments(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const copy = { ...(args as Record<string, unknown>) };
  if ("full_name" in copy) copy.full_name = "[REDACTED]";
  if ("date_of_birth" in copy) copy.date_of_birth = "[REDACTED]";
  if ("phone" in copy) copy.phone = "[REDACTED]";
  return copy;
}

function verifiedPatientId(result: ToolResponse): string | null {
  const data = result.data as { patient_id?: unknown } | undefined;
  return result.ok && typeof data?.patient_id === "string"
    ? data.patient_id
    : null;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function handleRouteError(
  error: unknown,
  toolName: string,
  requestId: string,
  startedAt: number,
): Response {
  if (error instanceof InvalidJsonError) {
    logToolCall(toolName, requestId, startedAt, "failed", "invalid_json");
    return withRequestId(
      Response.json(
        { ok: false, code: "invalid_json", message: error.message },
        { status: 400 },
      ),
      requestId,
    );
  }
  // Driver messages can echo row values, so only the error class and SQLSTATE are logged.
  logToolCall(toolName, requestId, startedAt, "failed", "internal_error", {
    error: error instanceof Error ? error.name : "unknown",
    sqlstate: getPostgresErrorCode(error),
  });
  return withRequestId(
    Response.json(
      {
        ok: false,
        code: "internal_error",
        message:
          "I couldn't complete that request right now. Please try again.",
      },
      { status: 500 },
    ),
    requestId,
  );
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("x-request-id", requestId);
  return response;
}

function parseRequestId(value: string | null): string {
  const parsed = requestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : randomUUID();
}

function parseClientAddress(value: string | null): string {
  const firstAddress = value?.split(",")[0]?.trim() ?? "unknown";
  const parsed = clientAddressSchema.safeParse(firstAddress);
  return parsed.success ? parsed.data : "unknown";
}

function logToolCall(
  toolName: string,
  requestId: string,
  startedAt: number,
  outcome: "completed" | "rejected" | "failed",
  code: string,
  diagnostics: Record<string, unknown> = {},
): void {
  const log = outcome === "failed" ? console.error : console.info;
  log(
    JSON.stringify({
      event: "tool_call",
      tool: toolName,
      request_id: requestId,
      outcome,
      code,
      latency_ms: Math.round(performance.now() - startedAt),
      ...diagnostics,
    }),
  );
}

class InvalidJsonError extends Error {
  constructor() {
    super("The request body must be JSON.");
    this.name = "InvalidJsonError";
  }
}
