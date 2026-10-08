import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DIRECT_URL: z.string().min(1).optional(),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  RETELL_API_KEY: z.string().min(1).optional(),
  RETELL_AGENT_ID: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  CLINIC_NAME: z.string().default("Docto Family Clinic"),
  CLINIC_TIMEZONE: z.string().default("America/New_York"),
  PUBLIC_BASE_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  WEB_CALLS_ENABLED: z
    .string()
    .optional()
    .transform((val) => val === undefined || val === "" || val === "true" || val === "1")
    .default(true),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  RETELL_API_KEY: process.env.RETELL_API_KEY || undefined,
  RETELL_AGENT_ID: process.env.RETELL_AGENT_ID || undefined,
  LLM_API_KEY: process.env.LLM_API_KEY || undefined,
  CLINIC_NAME: process.env.CLINIC_NAME || undefined,
  CLINIC_TIMEZONE: process.env.CLINIC_TIMEZONE || undefined,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || undefined,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || undefined,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || undefined,
  CRON_SECRET: process.env.CRON_SECRET || undefined,
  WEB_CALLS_ENABLED: process.env.WEB_CALLS_ENABLED,
  NODE_ENV: process.env.NODE_ENV,
});

/**
 * Validates Retell configuration when a feature specifically requires it.
 * Fails with a clear actionable message at runtime instead of crashing on import.
 */
export function requireRetellConfig() {
  if (!env.RETELL_API_KEY) {
    throw new Error(
      "Retell integration is not configured. Please set RETELL_API_KEY in .env.local.",
    );
  }
  if (!env.RETELL_AGENT_ID) {
    throw new Error(
      "Retell agent is not configured. Please set RETELL_AGENT_ID in .env.local.",
    );
  }
  return {
    apiKey: env.RETELL_API_KEY,
    agentId: env.RETELL_AGENT_ID,
  };
}

/**
 * Returns Retell config if available, or null if optional/unconfigured.
 */
export function getRetellConfig() {
  if (!env.RETELL_API_KEY) return null;
  return {
    apiKey: env.RETELL_API_KEY,
    agentId: env.RETELL_AGENT_ID ?? null,
  };
}
