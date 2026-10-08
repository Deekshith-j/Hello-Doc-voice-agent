// Creates or updates the Retell LLM and agent from agent-definition.ts.
// Re-running with RETELL_LLM_ID and RETELL_AGENT_ID set updates in place instead of duplicating.
import { z } from "zod";

import { getClinicSettings } from "@/config/environment";

import {
  buildRetellAgent,
  buildRetellLlm,
  toolNames,
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
  RETELL_LLM_MODEL: z.string().default("gpt-4.1"),
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
const agentId = await api.upsertAgent(
  env.RETELL_AGENT_ID || null,
  buildRetellAgent(settings, llmId),
);

console.log(`Retell agent is configured with tools: ${toolNames().join(", ")}.
Tools and webhook point at ${env.PUBLIC_BASE_URL}.

Add these to your environment (Vercel project settings and .env.local):

RETELL_LLM_ID=${llmId}
RETELL_AGENT_ID=${agentId}
`);
