// Lists a verified patient's upcoming appointments so the agent can reschedule or cancel one.
// Patient IDs come from find_patient, so unverified callers have nothing to pass here.
import { listPatientAppointmentsSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "list_patient_appointments",
  schema: listPatientAppointmentsSchema,
  execute: (service, input) => service.listPatientAppointments(input),
});
