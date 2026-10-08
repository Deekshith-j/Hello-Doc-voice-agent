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

export interface RateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
}

export async function consumeRateLimit(
  store: RateLimitStore,
  key: string,
  now = new Date(),
  options?: RateLimitOptions,
): Promise<RateLimitResult> {
  const windowMs = options?.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const maxRequests = options?.maxRequests ?? MAX_REQUESTS_PER_WINDOW;
  const windowStartMs =
    Math.floor(now.getTime() / windowMs) * windowMs;
  const count = await store.incrementRateLimit(key, new Date(windowStartMs));
  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStartMs + windowMs - now.getTime()) / 1_000),
    ),
  };
}
