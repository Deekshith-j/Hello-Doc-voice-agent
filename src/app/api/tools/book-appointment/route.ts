// Creates an idempotent appointment after rechecking live availability.
// The idempotency key is derived on the server from call_id + patient_id + doctor_id + start_at.
// PostgreSQL's exclusion constraint remains the final defense against racing callers.
import { createHash } from "node:crypto";

import { bookAppointmentSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

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
