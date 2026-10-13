// Records named pass/fail checks for one eval case, including what was actually observed.
// Every tool reply is also checked for being safe and natural to speak aloud.
import type { EvalCaseResult } from "@/db/postgres-dashboard-repository";

import type { ToolReply } from "./tool-client";

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_SPOKEN_LENGTH = 320;

export class CaseRecorder {
  readonly checks: EvalCaseResult["checks"] = [];

  expect(name: string, passed: boolean, detail: string): void {
    this.checks.push({ name, passed, detail });
  }

  expectCode(step: string, reply: ToolReply, ...codes: string[]): void {
    this.expect(
      `${step} returns ${codes.join(" or ")}`,
      codes.includes(reply.body.code),
      `got ${reply.body.code} (HTTP ${reply.status})`,
    );
    this.expectSpeakable(step, reply);
  }

  expectSpeakable(step: string, reply: ToolReply): void {
    // Voice output must never contain machine identifiers or raw timestamps.
    const message = reply.body.message ?? "";
    const problems = [
      message.trim() === "" && "empty",
      ISO_TIMESTAMP.test(message) && "contains an ISO timestamp",
      UUID.test(message) && "contains an internal ID",
      message.length > MAX_SPOKEN_LENGTH && `is ${message.length} characters`,
    ].filter(Boolean);
    this.expect(
      `${step} message is speakable`,
      problems.length === 0,
      problems.length ? `Message ${problems.join(", ")}.` : `"${message}"`,
    );
  }
}
