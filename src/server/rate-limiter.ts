// Applies a fixed-window tool-call limit on top of a shared, atomic counter store.
// Postgres backs the store so separate Vercel instances enforce one combined limit.
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

export interface RateLimitStore {
  incrementRateLimit(key: string, windowStart: Date): Promise<number>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimit(
  store: RateLimitStore,
  key: string,
  now = new Date(),
): Promise<RateLimitResult> {
  const windowStartMs =
    Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const count = await store.incrementRateLimit(key, new Date(windowStartMs));
  return {
    allowed: count <= MAX_REQUESTS_PER_WINDOW,
    remaining: Math.max(0, MAX_REQUESTS_PER_WINDOW - count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStartMs + RATE_LIMIT_WINDOW_MS - now.getTime()) / 1_000),
    ),
  };
}
