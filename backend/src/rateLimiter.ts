export interface RateLimitPolicy {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private windowStartedAt: number | null = null;
  private requestCount = 0;

  consume(
    policy: RateLimitPolicy,
    now = Date.now(),
  ): RateLimitDecision {
    if (
      this.windowStartedAt === null ||
      now < this.windowStartedAt ||
      now >= this.windowStartedAt + policy.windowMs
    ) {
      this.windowStartedAt = now;
      this.requestCount = 0;
    }

    if (this.requestCount >= policy.maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            (this.windowStartedAt + policy.windowMs - now) / 1_000,
          ),
        ),
      };
    }

    this.requestCount += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
