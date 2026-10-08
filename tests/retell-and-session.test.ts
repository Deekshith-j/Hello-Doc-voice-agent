// Pins the security primitives: Retell request signatures and dashboard session tokens.
// Fixed clocks make expiry and replay windows deterministic.
import { describe, expect, it } from "vitest";

import {
  signRetellPayload,
  verifyRetellSignature,
} from "@/integrations/retell/signature";
import { toCallEnded } from "@/integrations/retell/webhook-events";
import { createSessionToken, verifySessionToken } from "@/server/session-token";

const KEY = "retell-webhook-key";
const NOW = 1_800_000_000_000;

describe("Retell signatures", () => {
  it("accepts a payload signed with the same key", () => {
    const body = '{"event":"call_started"}';
    expect(
      verifyRetellSignature(body, signRetellPayload(body, KEY, NOW), KEY, NOW),
    ).toBe(true);
  });

  it("rejects a tampered body, a wrong key, and a malformed header", () => {
    const signature = signRetellPayload('{"a":1}', KEY, NOW);
    expect(verifyRetellSignature('{"a":2}', signature, KEY, NOW)).toBe(false);
    expect(verifyRetellSignature('{"a":1}', signature, "other-key", NOW)).toBe(
      false,
    );
    expect(verifyRetellSignature('{"a":1}', "garbage", KEY, NOW)).toBe(false);
    expect(verifyRetellSignature('{"a":1}', null, KEY, NOW)).toBe(false);
  });

  it("rejects a replay older than five minutes", () => {
    const signature = signRetellPayload("{}", KEY, NOW);
    expect(
      verifyRetellSignature("{}", signature, KEY, NOW + 5 * 60_000 + 1),
    ).toBe(false);
  });
});

describe("dashboard sessions", () => {
  const secret = "a".repeat(32);

  it("accepts its own unexpired token", async () => {
    const token = await createSessionToken(secret, NOW);
    expect(await verifySessionToken(token, secret, NOW + 1_000)).toBe(true);
  });

  it("rejects expired, forged, and missing tokens", async () => {
    const token = await createSessionToken(secret, NOW);
    expect(
      await verifySessionToken(token, secret, NOW + 13 * 60 * 60_000),
    ).toBe(false);
    expect(await verifySessionToken(token, "b".repeat(32), NOW)).toBe(false);
    const [payload] = token.split(".");
    expect(await verifySessionToken(`${payload}.forged`, secret, NOW)).toBe(
      false,
    );
    expect(await verifySessionToken(undefined, secret, NOW)).toBe(false);
  });
});

describe("Retell webhook mapping", () => {
  it("keeps only spoken turns with their start offsets", () => {
    const event = toCallEnded(
      {
        call_id: "call_1",
        start_timestamp: NOW,
        end_timestamp: NOW + 60_000,
        disconnection_reason: "user_hangup",
        latency: { e2e: { p50: 812.4 } },
        transcript_object: [
          { role: "agent", content: " Hello. ", words: [{ start: 0.4 }] },
          { role: "tool_call_invocation", content: "{}" },
          { role: "user", content: "Hi", words: [] },
        ],
      },
      new Date(NOW),
    );
    expect(event.transcript).toEqual([
      { speaker: "agent", text: "Hello.", offsetSeconds: 0.4 },
      { speaker: "caller", text: "Hi", offsetSeconds: null },
    ]);
    expect(event.e2eLatencyP50Ms).toBe(812);
  });
});

describe("Test database safety guard", () => {
  it("throws when TEST_DATABASE_URL equals DATABASE_URL", async () => {
    const { assertTestDatabaseSafety } = await import("./support/test-database");
    const testUrl = "postgresql://postgres:secret@db.supabase.co:5432/postgres";
    expect(() => assertTestDatabaseSafety(testUrl, testUrl)).toThrow(
      /Safety guard violation/,
    );
  });

  it("throws when TEST_DATABASE_URL shares the same Supabase project identifier", async () => {
    const { assertTestDatabaseSafety } = await import("./support/test-database");
    const mainUrl =
      "postgresql://postgres.myproj123:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres";
    const testUrl =
      "postgresql://postgres.myproj123:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
    expect(() => assertTestDatabaseSafety(mainUrl, testUrl)).toThrow(
      /Safety guard violation/,
    );
  });

  it("permits distinct database URLs and distinct projects", async () => {
    const { assertTestDatabaseSafety } = await import("./support/test-database");
    const mainUrl =
      "postgresql://postgres.projA:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres";
    const testUrl =
      "postgresql://postgres.projB:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
    expect(() => assertTestDatabaseSafety(mainUrl, testUrl)).not.toThrow();
  });
});

describe("Fail closed Retell authentication", () => {
  it("rejects requests in production when signing key is missing", async () => {
    const { authenticateRetellRequest, retellAuthFailure } = await import(
      "@/server/retell-request"
    );
    const envObj = process.env as Record<string, string | undefined>;
    const original = envObj.NODE_ENV;
    try {
      envObj.NODE_ENV = "production";
      const result = authenticateRetellRequest("{}", null, null);
      expect(result).toBe("not_configured");
      const response = retellAuthFailure(result);
      expect(response?.status).toBe(503);
    } finally {
      envObj.NODE_ENV = original;
    }
  });

  it("permits unsigned requests in non-production when signing key is unset", async () => {
    const { authenticateRetellRequest, retellAuthFailure } = await import(
      "@/server/retell-request"
    );
    const envObj = process.env as Record<string, string | undefined>;
    const original = envObj.NODE_ENV;
    try {
      envObj.NODE_ENV = "development";
      const result = authenticateRetellRequest("{}", null, null);
      expect(result).toBe("unsigned_allowed");
      expect(retellAuthFailure(result)).toBeNull();
    } finally {
      envObj.NODE_ENV = original;
    }
  });
});

