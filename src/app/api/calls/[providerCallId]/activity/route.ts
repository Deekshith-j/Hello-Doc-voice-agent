// Returns the tool activity recorded so far for one live call, for the operator's call screen.
// Polled every few seconds during a web call; reads one call by its unique provider ID.
import { z } from "zod";

import { operatorApiGuard } from "@/server/dashboard-session";
import { getToolRuntime } from "@/server/tool-runtime";

const providerCallIdSchema = z.string().min(1).max(200);

export async function GET(
  _request: Request,
  context: RouteContext<"/api/calls/[providerCallId]/activity">,
): Promise<Response> {
  const unauthorized = await operatorApiGuard();
  if (unauthorized) return unauthorized;

  const parsed = providerCallIdSchema.safeParse(
    (await context.params).providerCallId,
  );
  if (!parsed.success)
    return Response.json(
      { ok: false, code: "invalid_request" },
      { status: 400 },
    );

  const activity = await getToolRuntime().dashboard.getLiveActivity(
    parsed.data,
  );
  return Response.json(
    { ok: true, activity },
    { headers: { "Cache-Control": "no-store" } },
  );
}
