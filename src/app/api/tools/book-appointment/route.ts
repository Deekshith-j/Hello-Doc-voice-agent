// WHAT: HTTP route handler for the `book_appointment` Retell tool.
// WHY: Ensures safe booking by wrapping the operation in HMAC signature validation,
// per-call rate limiting, and deterministic server-side idempotency key derivation.
import { createHash } from "node:crypto";

import { bookAppointmentSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

// WHY SERVER-DERIVED IDEMPOTENCY KEY:
// Voice LLM gateways frequently retry tool HTTP calls when downstream latency spikes near their timeout.
// The voice model itself cannot be trusted to generate and retain stable idempotency tokens across turns.
// We derive a deterministic SHA-256 hash from (call_id, patient, doctor, canonicalStart).
// - Canonicalizing startAt via `.toISOString()` prevents string format discrepancies (e.g. "+00:00" vs "Z") from yielding different keys.
// - Scope isolation: Binding to callId ensures retries within the same phone call safely deduplicate, while distinct calls remain independent.
// - If network drops after DB commit, Retell's retry hits the unique index on idempotency_key and safely returns the existing appointment.
export function deriveIdempotencyKey(
  callId: string | null,
  patientId: string,
  doctorId: string,
  startAt: string,
): string {
  const canonicalStart = new Date(startAt).toISOString();
  const source = `${callId ?? "direct"}:${patientId}:${doctorId}:${canonicalStart}`;
  return createHash("sha256").update(source).digest("hex");
}

export const POST = createToolRoute({
  name: "book_appointment",
  schema: bookAppointmentSchema,
  execute: (service, input, { callId }) => {
    const patientIdentifier =
      input.patient_id ??
      `${input.full_name?.trim().toLowerCase()}:${input.date_of_birth}`;
    const idempotencyKey = deriveIdempotencyKey(
      callId,
      patientIdentifier,
      input.doctor_id,
      input.start_at,
    );
    return service.bookAppointment({
      ...input,
      idempotency_key: idempotencyKey,
    });
  },
});
