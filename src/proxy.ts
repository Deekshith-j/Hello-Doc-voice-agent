// Redirects signed-out visitors away from dashboard pages before any rendering work starts.
// This is an optimistic check only; pages and dashboard APIs verify the session again.
import { type NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/server/session-token";

export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  // Without a secret the page-level check decides (open in development, closed in production).
  if (!secret) return NextResponse.next();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, secret)) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // API routes authenticate themselves (Retell signatures, cron secret, or the session).
  matcher: ["/((?!api|login|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
