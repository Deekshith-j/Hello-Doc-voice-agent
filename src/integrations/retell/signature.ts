// Verifies Retell's X-Retell-Signature header on webhooks and custom-function requests.
// Format: "v=<unix ms>,d=<hex HMAC-SHA256 of rawBody + timestamp>" keyed by the webhook API key.
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PATTERN = /^v=(\d+),d=([0-9a-f]+)$/;
// Retell documents a five-minute window; older signatures are treated as replays.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function verifyRetellSignature(
  rawBody: string,
  header: string | null,
  apiKey: string,
  now = Date.now(),
): boolean {
  const match = header ? SIGNATURE_PATTERN.exec(header) : null;
  const timestamp = match?.[1];
  const digest = match?.[2];
  if (!timestamp || !digest) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return false;

  const expected = Buffer.from(hmac(rawBody, timestamp, apiKey), "hex");
  const received = Buffer.from(digest, "hex");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

export function signRetellPayload(
  rawBody: string,
  apiKey: string,
  now = Date.now(),
): string {
  // Used by tests and the eval harness to exercise the same verification path as Retell.
  const timestamp = String(now);
  return `v=${timestamp},d=${hmac(rawBody, timestamp, apiKey)}`;
}

function hmac(rawBody: string, timestamp: string, apiKey: string): string {
  return createHmac("sha256", apiKey)
    .update(rawBody + timestamp)
    .digest("hex");
}
