// Calls Retell's management API for web-call tokens and agent configuration.
// The API key stays on the server; browsers receive only short-lived call access tokens.
import { z } from "zod";

const RETELL_API_BASE_URL = "https://api.retellai.com";
const REQUEST_TIMEOUT_MS = 10_000;

const webCallSchema = z.object({
  access_token: z.string().min(1),
  call_id: z.string().min(1),
});
const llmSchema = z.object({ llm_id: z.string().min(1) });
const agentSchema = z.object({ agent_id: z.string().min(1) });

export class RetellApiError extends Error {
  constructor(public readonly status: number) {
    super(`Retell API request failed with status ${status}.`);
    this.name = "RetellApiError";
  }
}

export interface WebCallSession {
  accessToken: string;
  callId: string;
}

export class RetellApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async createWebCall(
    agentId: string,
    metadata: Record<string, string>,
  ): Promise<WebCallSession> {
    const payload = webCallSchema.parse(
      await this.request("POST", "/v3/create-web-call", {
        agent_id: agentId,
        metadata,
      }),
    );
    return { accessToken: payload.access_token, callId: payload.call_id };
  }

  async upsertLlm(llmId: string | null, body: object): Promise<string> {
    const payload = llmId
      ? await this.request("PATCH", `/update-retell-llm/${llmId}`, body)
      : await this.request("POST", "/create-retell-llm", body);
    return llmSchema.parse(payload).llm_id;
  }

  async upsertAgent(agentId: string | null, body: object): Promise<string> {
    const payload = agentId
      ? await this.request("PATCH", `/update-agent/${agentId}`, body)
      : await this.request("POST", "/create-agent", body);
    return agentSchema.parse(payload).agent_id;
  }

  private async request(
    method: "POST" | "PATCH",
    path: string,
    body: object,
  ): Promise<unknown> {
    const response = await this.fetcher(`${RETELL_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new RetellApiError(response.status);
    return response.json();
  }
}
