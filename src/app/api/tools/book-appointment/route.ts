// Creates an idempotent appointment after rechecking live availability.
// PostgreSQL's exclusion constraint remains the final defense against racing callers.
import { toolFailure } from "@/application/tool-response";
import { bookAppointmentSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "book_appointment",
  schema: bookAppointmentSchema,
  execute: (service, input, { callId }) => {
    // One call booking one slot is one logical request, however often Retell retries it.
    const idempotencyKey =
      input.idempotency_key ??
      (callId ? `${callId}:${input.doctor_id}:${input.start_at}` : null);
    if (!idempotencyKey)
      return Promise.resolve(
        toolFailure(
          "invalid_request",
          "Booking needs an idempotency key outside a voice call.",
        ),
      );
    return service.bookAppointment({
      ...input,
      idempotency_key: idempotencyKey,
    });
  },
});
