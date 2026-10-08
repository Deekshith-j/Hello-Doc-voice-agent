// Decides whether the current request belongs to a signed-in clinic operator.
// Pages and dashboard APIs call this directly; the proxy's redirect is only a fast first check.
import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getDashboardAuthConfig, isProduction } from "@/config/environment";

import { SESSION_COOKIE, verifySessionToken } from "./session-token";

export type SessionState = "signed_in" | "signed_out" | "auth_not_configured";

export const getSessionState = cache(async (): Promise<SessionState> => {
  const config = getDashboardAuthConfig();
  // Local development without credentials stays open; production never does.
  if (!config) return isProduction() ? "auth_not_configured" : "signed_in";
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return (await verifySessionToken(token, config.sessionSecret))
    ? "signed_in"
    : "signed_out";
});

export async function requireOperator(): Promise<void> {
  if ((await getSessionState()) !== "signed_in") redirect("/login");
}

export async function operatorApiGuard(): Promise<Response | null> {
  if ((await getSessionState()) === "signed_in") return null;
  return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
}
