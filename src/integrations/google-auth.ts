// Creates a refresh-token access-token provider for server-to-server calendar calls.
// Google Auth Library owns token caching and refresh timing instead of custom OAuth logic.
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

import type { GoogleOAuthConfig } from "@/config/environment";

export function createGoogleAccessTokenProvider(config: GoogleOAuthConfig) {
  const client = new OAuth2Client(config.clientId, config.clientSecret);
  client.setCredentials({ refresh_token: config.refreshToken });

  return async function getAccessToken(): Promise<string> {
    const result = await client.getAccessToken();
    return z.string().min(1).parse(result.token);
  };
}
