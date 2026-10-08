// Signs clinic operators in and out with a single shared dashboard passphrase.
// Comparison is constant-time and failures reveal nothing about why sign-in was refused.
"use server";

import { createHash, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getDashboardAuthConfig, isProduction } from "@/config/environment";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/server/session-token";

export interface SignInState {
  error: string | null;
}

export async function signIn(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const config = getDashboardAuthConfig();
  if (!config)
    return {
      error: "Sign-in isn't set up. Add DASHBOARD_PASSWORD and SESSION_SECRET.",
    };
  const password = formData.get("password");
  if (typeof password !== "string" || !matches(password, config.password))
    return { error: "That passphrase is incorrect." };

  (await cookies()).set(
    SESSION_COOKIE,
    await createSessionToken(config.sessionSecret),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    },
  );
  redirect(safeNextPath(formData.get("next")));
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

function matches(candidate: string, expected: string): boolean {
  // Hashing first gives equal-length buffers, so length never leaks through timing.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

function safeNextPath(value: FormDataEntryValue | null): string {
  // Only same-site paths are allowed, so the sign-in form can't become an open redirect.
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : "/";
}
