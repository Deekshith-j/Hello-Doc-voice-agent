// WHAT: Multi-provider LLM API client supporting Gemini and OpenAI-compatible endpoints with token cost tracking.
// WHY: Enforces hard cost caps ($2.00 cap per eval run), rate-limit backoff, and vendor-agnostic chat completions
// for the agent, patient simulator, and judge models.
import process from "node:process";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local may not exist or might already be loaded
}

export class BudgetExceededError extends Error {
  constructor(public currentCostUsd: number, public capUsd: number) {
    super(
      `Budget exceeded: Current run cost $${currentCostUsd.toFixed(4)} has reached the hard cap of $${capUsd.toFixed(2)}. Aborting further calls.`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface ModelPricing {
  promptCostPerMillion: number;
  completionCostPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini": { promptCostPerMillion: 0.15, completionCostPerMillion: 0.6 },
  "gpt-4o": { promptCostPerMillion: 2.5, completionCostPerMillion: 10.0 },
  "o3-mini": { promptCostPerMillion: 1.1, completionCostPerMillion: 4.4 },
  "claude-3-5-haiku-20241022": { promptCostPerMillion: 0.8, completionCostPerMillion: 4.0 },
  "claude-3-5-sonnet-20241022": { promptCostPerMillion: 3.0, completionCostPerMillion: 15.0 },
  "gemini-2.5-flash": { promptCostPerMillion: 0.075, completionCostPerMillion: 0.3 },
  "gemini-3.5-flash": { promptCostPerMillion: 0.15, completionCostPerMillion: 0.6 },
  "gemini-3.5-flash-lite": { promptCostPerMillion: 0.05, completionCostPerMillion: 0.2 },
  "gemini-3.1-flash-lite": { promptCostPerMillion: 0.05, completionCostPerMillion: 0.2 },
  "gemini-flash-latest": { promptCostPerMillion: 0.075, completionCostPerMillion: 0.3 },
  "gemini-flash-lite-latest": { promptCostPerMillion: 0.05, completionCostPerMillion: 0.2 },
};

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }[];
}

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost_usd: number;
}

export class LlmClient {
  private apiKey: string;
  private baseUrl: string;
  private hardCapUsd: number;
  private totalCostUsd = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    hardCapUsd?: number;
  }) {
    this.apiKey = options?.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.baseUrl =
      options?.baseUrl ??
      process.env.LLM_BASE_URL ??
      "https://api.openai.com/v1";
    this.hardCapUsd = options?.hardCapUsd ?? 2.0;

    if (!this.apiKey) {
      // Do not throw on construct so unit tests or help commands can initialize
    }
  }

  getProviderName(): string {
    if (!this.apiKey) return "unknown (no key provided)";
    if (this.baseUrl.includes("openrouter.ai")) return "OpenRouter";
    if (this.baseUrl.includes("groq.com")) return "Groq";
    if (this.baseUrl.includes("anthropic.com")) return "Anthropic";
    if (this.baseUrl.includes("googleapis.com") || this.apiKey.startsWith("AQ.")) return "Google Gemini";
    if (this.apiKey.startsWith("sk-ant-")) return "Anthropic";
    if (this.apiKey.startsWith("sk-proj-") || this.apiKey.startsWith("sk-"))
      return "OpenAI";
    if (this.apiKey.startsWith("gsk_")) return "Groq";
    if (this.apiKey.startsWith("or-")) return "OpenRouter";
    if (this.apiKey.startsWith("AIza")) return "Google Gemini";
    return "Custom OpenAI-compatible provider";
  }

  isKeyConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  getTotalCost(): number {
    return this.totalCostUsd;
  }

  getHardCap(): number {
    return this.hardCapUsd;
  }

  getTotalTokens(): { prompt: number; completion: number; total: number } {
    return {
      prompt: this.totalPromptTokens,
      completion: this.totalCompletionTokens,
      total: this.totalPromptTokens + this.totalCompletionTokens,
    };
  }

  resetSpending(): void {
    this.totalCostUsd = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
  }

  calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const pricing = MODEL_PRICING[model] ?? {
      promptCostPerMillion: 0.5,
      completionCostPerMillion: 1.5,
    };
    return (
      (promptTokens / 1_000_000) * pricing.promptCostPerMillion +
      (completionTokens / 1_000_000) * pricing.completionCostPerMillion
    );
  }

  async smokeTestModel(modelName: string): Promise<{
    success: boolean;
    error?: string;
    model: string;
  }> {
    if (!this.isKeyConfigured()) {
      return {
        success: false,
        error: "LLM_API_KEY is not set in .env.local",
        model: modelName,
      };
    }

    try {
      await this.chatCompletion({
        model: modelName,
        messages: [{ role: "user", content: "Reply with 'ok'." }],
        max_tokens: 5,
        temperature: 0,
      });
      return { success: true, model: modelName };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        model: modelName,
      };
    }
  }

  async chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
    tools?: ChatCompletionTool[];
    tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
    temperature?: number;
    max_tokens?: number;
  }): Promise<ChatCompletionResult> {
    if (!this.apiKey) {
      throw new Error(
        "LLM_API_KEY is not set. Please set LLM_API_KEY in .env.local to run evals.",
      );
    }

    if (this.totalCostUsd >= this.hardCapUsd) {
      throw new BudgetExceededError(this.totalCostUsd, this.hardCapUsd);
    }

    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.2,
    };
    if (params.max_tokens) body.max_tokens = params.max_tokens;
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools;
      if (params.tool_choice) body.tool_choice = params.tool_choice;
    }

    const maxRetries = 4;
    let attempt = 0;
    let response: Response | undefined;
    let errText = "";

    while (attempt <= maxRetries) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        break;
      }

      errText = await response.text();
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        let waitMs = 2500 * Math.pow(2, attempt);
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed) && parsed > 0) waitMs = parsed * 1000;
        } else {
          const match = errText.match(/retryDelay"?:\s*"(\d+(?:\.\d+)?)s/i);
          if (match && match[1]) {
            waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 500;
          }
        }

        if (waitMs > 60000) {
          throw new Error(
            `LLM API daily quota exhausted for ${params.model} (retry in ${(waitMs / 3600000).toFixed(1)}h): ${errText}`,
          );
        }

        console.warn(`[LLM RateLimit/Error ${response.status}] Retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, waitMs));
        attempt++;
        continue;
      }

      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    if (!response || !response.ok) {
      throw new Error(`LLM API returned ${response?.status ?? "unknown"}: ${errText}`);
    }

    const data = (await response.json()) as {
      choices: {
        message: ChatMessage;
      }[];
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new Error("No choices returned from LLM API");
    }

    const usage = data.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    const cost = this.calculateCost(
      params.model,
      usage.prompt_tokens,
      usage.completion_tokens,
    );

    this.totalCostUsd += cost;
    this.totalPromptTokens += usage.prompt_tokens;
    this.totalCompletionTokens += usage.completion_tokens;

    if (this.totalCostUsd > this.hardCapUsd) {
      throw new BudgetExceededError(this.totalCostUsd, this.hardCapUsd);
    }

    return {
      message: choice.message,
      usage,
      cost_usd: cost,
    };
  }
}

let defaultClient: LlmClient | null = null;
export function getLlmClient(): LlmClient {
  if (!defaultClient) {
    defaultClient = new LlmClient();
  }
  return defaultClient;
}
