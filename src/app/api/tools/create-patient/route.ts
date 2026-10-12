// WHAT: HTTP route handler for the `create_patient` Retell tool.
// WHY: Registers new patients while ensuring safe idempotency, HMAC request authentication,
// and automatic association of newly created patients with the active voice call record.
import { createHash } from "node:crypto";

import { createPatientSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

// WHY PATIENT IDEMPOTENCY KEY DERIVATION:
// Network retries from Retell must never spawn duplicate patient records or fail midway.
// Deriving an idempotency key from (call_id, normalized_name, DOB, phone):
// 1. Normalizes casing and whitespace on full_name to prevent transcription flutter from generating multiple profiles.
// 2. Produces a stable UUID via deterministic hashing in the application layer, allowing safe retries to replay the created record.
// 3. Guards against race conditions if duplicate packets arrive in parallel.
export function derivePatientIdempotencyKey(
  callId: string | null,
  fullName: string,
  dateOfBirth: string,
  phone: string,
): string {
  const source = `${callId ?? "direct"}:${fullName.trim().toLowerCase()}:${dateOfBirth}:${phone}`;
  return createHash("sha256").update(source).digest("hex");
}

export const POST = createToolRoute({
  name: "create_patient",
  schema: createPatientSchema,
  linksVerifiedPatient: true,
  execute: (service, input, { callId }) => {
    const idempotencyKey = derivePatientIdempotencyKey(
      callId,
      input.full_name,
      input.date_of_birth,
      input.phone,
    );
    return service.createPatient({
      ...input,
      idempotency_key: idempotencyKey,
    });
  },
});
