// Verifies the shared HTTP adapter: Retell signatures, envelopes, rate limits, and error mapping.
// The runtime is replaced so these checks isolate transport behavior from business rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AppointmentToolService } from "@/application/appointment-tool-service";
import type { ToolCallRecord } from "@/application/call-log";
import { ToolBusinessError } from "@/application/errors";
import { type ToolResponse, toolSuccess } from "@/application/tool-response";
import { signRetellPayload } from "@/integrations/retell/signature";
import type { RateLimitResult } from "@/server/rate-limiter";
import { createToolRoute, type ToolDefinition } from "@/server/tool-route";

const SIGNING_KEY = "test-signing-key";
const REQUEST_ID = "7b0b5b5e-2b7e-4c38-9f0a-3c1a1c6f2d11";
const schema = z.object({ name: z.string().min(2) }).strict();
const allowed: RateLimitResult = {
  allowed: true,
  remaining: 29,
  retryAfterSeconds: 60,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool route adapter", () => {
  it("unwraps a signed Retell envelope and records the call's tool use", async () => {
    const execute = vi.fn(async () => toolSuccess("done", "Done.", {}));
    const { route, recorded, limitKeys } = setup(execute);
    const response = await route(
      retellRequest({ name: "Alex" }, "call_123", { requestId: REQUEST_ID }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      { name: "Alex" },
      { callId: "call_123" },
    );
    expect(recorded[0]).toMatchObject({
      providerCallId: "call_123",
      toolName: "test_tool",
    });
    expect(limitKeys).toEqual(["test_tool:call:call_123"]);
  });

  it("rejects a request whose signature does not match", async () => {
    const execute = vi.fn();
    const { route } = setup(execute);
    const request = retellRequest({ name: "Alex" }, "call_123", {
      signature: "v=1,d=00",
    });
    const response = await route(request);

    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns validation problems to the agent instead of a transport error", async () => {
    const execute = vi.fn();
    const { route } = setup(execute);
    const response = await route(
      retellRequest({ name: "A", extra: 1 }, "call_1"),
    );
    const body = (await response.json()) as ToolResponse<{ issues: string[] }>;

    expect(response.status).toBe(200);
    expect(body.code).toBe("invalid_request");
    expect(body.data?.issues.join(" ")).toContain("name");
    expect(execute).not.toHaveBeenCalled();
  });

  it("tells the agent to slow down when the call exceeds its rate limit", async () => {
    const execute = vi.fn();
    const { route } = setup(execute, {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    });
    const body = (await (
      await route(retellRequest({ name: "Alex" }, "call_1"))
    ).json()) as ToolResponse;

    expect(body.code).toBe("rate_limited");
    expect(execute).not.toHaveBeenCalled();
  });

  it("turns business errors into speakable failures", async () => {
    const { route } = setup(async () => {
      throw new ToolBusinessError("calendar_unavailable", "Try shortly.", 503);
    });
    const response = await route(retellRequest({ name: "Alex" }, "call_1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      code: "calendar_unavailable",
      message: "Try shortly.",
    });
  });

  it("hides unexpected error details from the caller and logs only the class", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { route } = setup(async () => {
      throw Object.assign(new Error("duplicate key (phone)=(+15555550101)"), {
        code: "23505",
      });
    });
    const response = await route(retellRequest({ name: "Alex" }, "call_1"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("+1555");
    const logged = String(errorLog.mock.calls[0]?.[0]);
    expect(logged).toContain('"sqlstate":"23505"');
    expect(logged).not.toContain("+1555");
  });

  it("still answers the caller when the audit log write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { route } = setup(
      async () => toolSuccess("done", "Done.", {}),
      allowed,
      true,
    );
    const response = await route(retellRequest({ name: "Alex" }, "call_1"));
    expect((await response.json()).code).toBe("done");
  });
});

function setup(
  execute: ToolDefinition<typeof schema>["execute"],
  limit: RateLimitResult = allowed,
  failLogging = false,
) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const recorded: ToolCallRecord[] = [];
  const limitKeys: string[] = [];
  const route = createToolRoute({ name: "test_tool", schema, execute }, () => ({
    service: {} as AppointmentToolService,
    retellSigningKey: SIGNING_KEY,
    consumeRateLimit: async (key) => {
      limitKeys.push(key);
      return limit;
    },
    callLog: {
      recordCallStarted: async () => {},
      recordCallEnded: async () => {},
      recordCallAnalyzed: async () => {},
      recordToolCall: async (record) => {
        if (failLogging) throw new Error("database unavailable");
        recorded.push(record);
      },
    },
  }));
  return { route, recorded, limitKeys };
}

function retellRequest(
  args: unknown,
  callId: string,
  options: { requestId?: string; signature?: string } = {},
): Request {
  const body = JSON.stringify({
    name: "test_tool",
    call: { call_id: callId },
    args,
  });
  return new Request("http://localhost/api/tools/test", {
    method: "POST",
    headers: {
      "x-retell-signature":
        options.signature ?? signRetellPayload(body, SIGNING_KEY),
      ...(options.requestId ? { "x-request-id": options.requestId } : {}),
    },
    body,
  });
}
