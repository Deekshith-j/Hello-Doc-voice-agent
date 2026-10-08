// Lets the agent resolve a doctor the caller names into a doctor_id and specialty.
// Only public roster fields are returned; calendar configuration stays server-side.
import { listDoctorsSchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "list_doctors",
  schema: listDoctorsSchema,
  execute: (service, input) => service.listDoctors(input),
});
