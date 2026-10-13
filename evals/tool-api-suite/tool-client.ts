// Calls tool route handlers exactly as Retell does: a signed { name, call, args } envelope.
// Going through the HTTP handlers means evals exercise auth, validation, and logging too.
import type { ToolResponse } from "@/application/tool-response";
import { signRetellPayload } from "@/integrations/retell/signature";

type RouteHandler = (request: Request) => Promise<Response>;

export interface ToolReply {
  body: ToolResponse;
  status: number;
}

export class ToolClient {
  constructor(
    private readonly routes: Record<string, RouteHandler>,
    private readonly signingKey: string,
  ) {}

  async call(
    tool: string,
    args: unknown,
    callId: string,
    options: { sign?: boolean } = {},
  ): Promise<ToolReply> {
    const handler = this.routes[tool];
    if (!handler) throw new Error(`No route is registered for ${tool}.`);
    const rawBody = JSON.stringify({
      name: tool,
      call: { call_id: callId },
      args,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.sign ?? true)
      headers["x-retell-signature"] = signRetellPayload(
        rawBody,
        this.signingKey,
      );
    const response = await handler(
      new Request(`http://evals.local/api/tools/${tool}`, {
        method: "POST",
        headers,
        body: rawBody,
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as ToolResponse,
    };
  }
}
