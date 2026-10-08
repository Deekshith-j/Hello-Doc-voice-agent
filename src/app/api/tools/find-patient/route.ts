// Exposes verified patient lookup to the voice agent without returning sensitive fields.
// A successful match links the call record to the patient for later review.
import { findPatientSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "find_patient",
  schema: findPatientSchema,
  linksVerifiedPatient: true,
  execute: (service, input) => service.findPatient(input),
});
