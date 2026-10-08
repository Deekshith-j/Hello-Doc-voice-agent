// Authenticates requests that claim to come from Retell, for tools and webhooks alike.
// Production requires a valid signature; development accepts unsigned requests for local testing.
import { isProduction } from "@/config/environment";
import { verifyRetellSignature } from "@/integrations/retell/signature";

export type RetellAuthResult =
  "verified" | "unsigned_allowed" | "rejected" | "not_configured";

export function authenticateRetellRequest(
  rawBody: string,
  signature: string | null,
  signingKey: string | null,
): RetellAuthResult {
  if (signingKey)
    return verifyRetellSignature(rawBody, signature, signingKey)
      ? "verified"
      : "rejected";
  return isProduction() ? "not_configured" : "unsigned_allowed";
}

export function retellAuthFailure(result: RetellAuthResult): Response | null {
  if (result === "rejected")
    return Response.json(
      { ok: false, code: "invalid_signature" },
      { status: 401 },
    );
  if (result === "not_configured")
    return Response.json(
      { ok: false, code: "retell_not_configured" },
      { status: 503 },
    );
  return null;
}
