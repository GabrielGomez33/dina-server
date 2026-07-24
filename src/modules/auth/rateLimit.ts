// File: src/modules/auth/rateLimit.ts
// ============================================================================
// DINA AUTH — IN-MEMORY RATE LIMITER (per key, fixed window)
// ============================================================================
// A small dependency-free limiter for the sensitive auth endpoints (login,
// register, forgot-password). Keyed by "<action>:<ip>". Fixed-window counters
// in a Map, swept periodically so memory stays bounded. This is a single-process
// limiter — adequate for one pm2 instance; move to Redis if DINA scales out.
// ============================================================================

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Evict stale buckets every 5 minutes so a flood of unique IPs can't grow the
// map without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Consume one unit against `key`. Returns whether the request is allowed and
 * how many remain in the current window.
 * @param key    stable identifier, e.g. `login:1.2.3.4`
 * @param limit  max requests per window
 * @param windowMs window length in ms
 */
export function hit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const allowed = b.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - b.count),
    retryAfterSec: Math.ceil((b.resetAt - now) / 1000),
  };
}

/** Test-only: clear all buckets. */
export function _resetRateLimits(): void {
  buckets.clear();
}
