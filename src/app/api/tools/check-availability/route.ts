// Exposes doctor or specialty availability using database and real-calendar busy time.
// The result stays intentionally short enough for a voice agent to offer a few choices.
import { checkAvailabilitySchema } from "@/application/tool-schemas";
import { createToolRoute } from "@/server/tool-route";

export const POST = createToolRoute({
  name: "check_availability",
  schema: checkAvailabilitySchema,
  execute: (service, input) => service.checkAvailability(input),
});
