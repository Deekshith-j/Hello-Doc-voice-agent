// Registers a new patient after explicit caller consent.
// The idempotency key is derived on the server from call_id + full_name + date_of_birth + phone.
// A successful registration links the call record to the newly created patient.
import { createHash } from "node:crypto";

import { createPatientSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

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
