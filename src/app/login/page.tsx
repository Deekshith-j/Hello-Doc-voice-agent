// Asks clinic operators for the shared dashboard passphrase.
// Signed-in visitors skip straight to the workspace; the form itself is a small client island.
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DoctoLogo } from "@/components/docto-logo";
import { getSessionState } from "@/server/dashboard-session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Docto",
  description: "Sign in to the Docto clinic front-desk workspace.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const state = await getSessionState();
  const next = (await searchParams).next;
  const nextPath =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
      ? next
      : "/";
  if (state === "signed_in") redirect(nextPath);

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="enter w-full max-w-sm">
        <DoctoLogo />
        <div className="mt-6 rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-lg font-semibold tracking-[-0.02em]">
            Sign in to the front desk
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use the clinic&apos;s dashboard passphrase.
          </p>
          {state === "auth_not_configured" ? (
            <p className="mt-4 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
              Sign-in isn&apos;t set up on this deployment. Add
              DASHBOARD_PASSWORD and SESSION_SECRET.
            </p>
          ) : null}
          <LoginForm nextPath={nextPath} />
        </div>
      </div>
    </main>
  );
}
