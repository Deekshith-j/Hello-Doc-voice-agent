// Moves an existing appointment while preserving its audit history and calendar identity.
// Patient ownership is required so one verified caller cannot change another record.
import { rescheduleAppointmentSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "reschedule_appointment",
  schema: rescheduleAppointmentSchema,
  execute: (service, input) => service.rescheduleAppointment(input),
});
