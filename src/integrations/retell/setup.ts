// Creates or updates the Retell LLM and agent from agent-definition.ts.
// Re-running with RETELL_LLM_ID and RETELL_AGENT_ID set updates in place instead of duplicating.
import { z } from "zod";

import { getClinicSettings } from "@/config/environment";

import {
  buildRetellAgent,
  buildRetellLlm,
  toolSpecs,
} from "./agent-definition";
import { RetellApi } from "./retell-api";

const setupSchema = z.object({
  RETELL_API_KEY: z
    .string()
    .min(1, "Set RETELL_API_KEY (the key with the webhook badge)."),
  PUBLIC_BASE_URL: z
    .url({ error: "Set PUBLIC_BASE_URL to this deployment's https URL." })
    .refine(
      (value) => value.startsWith("https://"),
      "PUBLIC_BASE_URL must be https so Retell can reach it.",
    )
    .transform((value) => value.replace(/\/+$/, "")),
  RETELL_LLM_ID: z.string().optional(),
  RETELL_AGENT_ID: z.string().optional(),
  RETELL_LLM_MODEL: z.string().default("gpt-4.1-mini"),
  RETELL_VOICE_ID: z.string().default("retell-Cimo"),
});

const env = setupSchema.parse(process.env);
const clinic = getClinicSettings();
const settings = {
  clinicName: clinic.name,
  clinicTimeZone: clinic.timeZone,
  model: env.RETELL_LLM_MODEL,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  voiceId: env.RETELL_VOICE_ID,
};

const api = new RetellApi(env.RETELL_API_KEY);
const llmId = await api.upsertLlm(
  env.RETELL_LLM_ID || null,
  buildRetellLlm(settings),
);
let agentId: string;
if (env.RETELL_AGENT_ID) {
  try {
    agentId = await api.upsertAgent(
      env.RETELL_AGENT_ID,
      buildRetellAgent(settings, llmId),
    );
  } catch (error) {
    console.warn(
      `Could not update agent ${env.RETELL_AGENT_ID}, creating a new agent instead...`,
    );
    agentId = await api.upsertAgent(null, buildRetellAgent(settings, llmId));
  }
} else {
  agentId = await api.upsertAgent(null, buildRetellAgent(settings, llmId));
}

const registeredToolUrls = toolSpecs().map(
  (t) => `${settings.publicBaseUrl}/api/tools/${t.path}`,
);

console.log(`\n--- Retell Agent Setup Complete ---`);
console.log(`Agent ID: ${agentId}`);
console.log(`LLM ID: ${llmId}`);
console.log(`Webhook URL: ${settings.publicBaseUrl}/api/retell/webhook`);
console.log(`Registered Tools (${registeredToolUrls.length}):`);
for (const url of registeredToolUrls) {
  console.log(`  - ${url}`);
}
console.log(`\nAdd these to your environment (Vercel project settings and .env.local):`);
console.log(`RETELL_LLM_ID=${llmId}`);
console.log(`RETELL_AGENT_ID=${agentId}\n`);
