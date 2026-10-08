// Issues and verifies stateless dashboard session tokens with an HMAC signature.
// Web Crypto keeps this usable from both the request proxy and server components.
const encoder = new TextEncoder();

export const SESSION_COOKIE = "docto_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function createSessionToken(
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload = base64Url(
    encoder.encode(JSON.stringify({ exp: now + SESSION_TTL_SECONDS * 1_000 })),
  );
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const [payload, signature] = token?.split(".") ?? [];
  if (!payload || !signature) return false;
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    encoder.encode(payload),
  );
  if (!valid) return false;
  try {
    const { exp } = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload)),
    ) as { exp?: unknown };
    return typeof exp === "number" && exp > now;
  } catch {
    return false;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return base64Url(new Uint8Array(signature));
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
