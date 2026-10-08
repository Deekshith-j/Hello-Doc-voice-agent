// Wires the database, calendar, tool service, call log, and dashboard reads once per instance.
// The instance-level cache keeps one connection pool per warm serverless instance.
import { AppointmentToolService } from "@/application/appointment-tool-service";
import type { CallLogRepository } from "@/application/call-log";
import { CalendarSync } from "@/application/calendar-sync";
import {
  getDatabaseUrl,
  getGoogleOAuthConfig,
  getRetellConfig,
} from "@/config/environment";
import { createSqlClient } from "@/db/client";
import { PostgresCallLogRepository } from "@/db/postgres-call-log-repository";
import { PostgresClinicRepository } from "@/db/postgres-clinic-repository";
import { PostgresDashboardRepository } from "@/db/postgres-dashboard-repository";
import type { AvailabilitySource } from "@/domain/availability";
import { createAvailabilityService } from "@/domain/availability-service";
import { createGoogleAccessTokenProvider } from "@/integrations/google-auth";
import { GoogleCalendarSource } from "@/integrations/google-calendar-source";

import { consumeRateLimit, type RateLimitResult } from "./rate-limiter";

export interface ToolRuntime {
  calendarSync: CalendarSync;
  callLog: CallLogRepository;
  consumeRateLimit: (key: string) => Promise<RateLimitResult>;
  dashboard: PostgresDashboardRepository;
  ping: () => Promise<void>;
  // null means requests are accepted unsigned, which is only allowed outside production.
  retellSigningKey: string | null;
  service: AppointmentToolService;
}

// globalThis also survives development hot reloads, which would otherwise leak pools.
const globalForRuntime = globalThis as typeof globalThis & {
  doctoToolRuntime?: ToolRuntime;
};

export function getToolRuntime(): ToolRuntime {
  globalForRuntime.doctoToolRuntime ??= createToolRuntime();
  return globalForRuntime.doctoToolRuntime;
}

function createToolRuntime(): ToolRuntime {
  const sql = createSqlClient(getDatabaseUrl());
  const repository = new PostgresClinicRepository(sql);
  const calendar = createCalendarSource(repository);
  const calendarSync = new CalendarSync(repository, calendar);
  const service = new AppointmentToolService({
    repository,
    calendarSync,
    getSlots: createAvailabilityService(
      (doctorId, from, to) =>
        repository.loadAvailabilitySnapshot(doctorId, from, to),
      calendar,
    ),
  });
  return {
    calendarSync,
    callLog: new PostgresCallLogRepository(sql),
    consumeRateLimit: (key) => consumeRateLimit(repository, key),
    dashboard: new PostgresDashboardRepository(sql),
    retellSigningKey: getRetellConfig()?.apiKey ?? null,
    ping: () => repository.ping(),
    service,
  };
}

function createCalendarSource(
  repository: PostgresClinicRepository,
): AvailabilitySource | undefined {
  const config = getGoogleOAuthConfig();
  if (!config) return undefined;
  return new GoogleCalendarSource({
    getAccessToken: createGoogleAccessTokenProvider(config),
    resolveCalendarId: (doctorId) => repository.getCalendarId(doctorId),
  });
}
