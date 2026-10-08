// Validates server configuration at the boundary where environment strings enter the app.
// Optional integrations are all-or-nothing so partial credentials never fail silently.
import { z } from "zod";

const databaseUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith("postgres://") || value.startsWith("postgresql://"),
    {
      message: "DATABASE_URL must be a PostgreSQL connection URL.",
    },
  );

const googleConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type GoogleOAuthConfig = z.infer<typeof googleConfigSchema>;

export function getDatabaseUrl(): string {
  return databaseUrlSchema.parse(process.env.DATABASE_URL);
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  // Blank values from a copied .env.example count as unset, not as invalid credentials.
  const values = {
    clientId: process.env.GOOGLE_CLIENT_ID || undefined,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || undefined,
  };
  if (Object.values(values).every((value) => value === undefined)) return null;
  return googleConfigSchema.parse(values);
}

export function getCronSecret(): string | null {
  // Vercel Cron sends this value as a bearer token; short secrets are rejected as misconfiguration.
  const value = process.env.CRON_SECRET;
  if (value === undefined || value === "") return null;
  return z.string().min(32).parse(value);
}

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

export interface RetellConfig {
  agentId: string | null;
  apiKey: string;
}

export function getRetellConfig(): RetellConfig | null {
  const apiKey = optionalSecret.parse(process.env.RETELL_API_KEY);
  if (!apiKey) return null;
  return {
    apiKey,
    agentId: optionalSecret.parse(process.env.RETELL_AGENT_ID) ?? null,
  };
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export interface DashboardAuthConfig {
  password: string;
  sessionSecret: string;
}

export function getDashboardAuthConfig(): DashboardAuthConfig | null {
  // Both values are required together; a password without a signing secret cannot issue sessions.
  const password = optionalSecret.parse(process.env.DASHBOARD_PASSWORD);
  const sessionSecret = optionalSecret.parse(process.env.SESSION_SECRET);
  if (!password && !sessionSecret) return null;
  return z
    .object({
      password: z.string().min(12, "DASHBOARD_PASSWORD needs 12+ characters."),
      sessionSecret: z.string().min(32, "SESSION_SECRET needs 32+ characters."),
    })
    .parse({ password, sessionSecret });
}

export function getClinicSettings() {
  return z
    .object({
      name: z.string().min(1),
      timeZone: z.string().min(1),
    })
    .parse({
      name: process.env.CLINIC_NAME || "Docto Family Clinic",
      timeZone: process.env.CLINIC_TIMEZONE || "America/New_York",
    });
}
