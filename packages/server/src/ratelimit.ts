// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly counts = new Map<string, RateLimitEntry>();

  /**
   * Check and increment the counter for a key.
   *
   * @param key      Unique key to track (e.g. IP address, deviceId).
   * @param limit    Maximum number of requests allowed within windowMs.
   * @param windowMs Duration of the window in milliseconds.
   * @returns `true` if the request is allowed, `false` if the limit is exceeded.
   */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);

    if (!entry || now > entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (entry.count >= limit) {
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Remaining time in ms before the window resets for a key.
   * Returns 0 if there is no active window.
   */
  retryAfterMs(key: string): number {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now > entry.resetAt) return 0;
    return entry.resetAt - now;
  }

  /**
   * Prune expired entries to prevent unbounded memory growth.
   * Call this periodically (e.g. every 10 minutes).
   */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.counts) {
      if (now > entry.resetAt) this.counts.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared instances (singletons reused across modules)
// ---------------------------------------------------------------------------

/** 5 connection attempts per minute per source device (WS signaling) */
export const wsConnectLimiter = new RateLimiter();

/** 10 login attempts per hour per IP (REST auth routes) */
export const loginLimiter = new RateLimiter();

// Prune expired entries every 10 minutes
setInterval(() => {
  wsConnectLimiter.prune();
  loginLimiter.prune();
}, 10 * 60 * 1000).unref();
