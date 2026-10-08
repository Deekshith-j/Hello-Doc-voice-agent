// Cancels an appointment without deleting its audit history or original time range.
// Repeated cancellation requests return success so Retell retries remain harmless.
import { cancelAppointmentSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "cancel_appointment",
  schema: cancelAppointmentSchema,
  execute: (service, input) => service.cancelAppointment(input),
});
