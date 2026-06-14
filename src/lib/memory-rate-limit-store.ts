import type { RateLimitBucketRecord, RateLimitStore } from "./rate-limit";

export const memoryRateLimitStore: RateLimitStore = new (class implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucketRecord>();

  public async increment(input: { readonly key: string; readonly now: Date; readonly windowMs: number }): Promise<RateLimitBucketRecord> {
    const current = this.buckets.get(input.key);
    if (!current || current.expiresAt.getTime() <= input.now.getTime()) {
      const next = {
        count: 1,
        expiresAt: new Date(input.now.getTime() + input.windowMs),
        key: input.key,
        windowStart: input.now
      };
      this.buckets.set(input.key, next);
      return next;
    }

    const next = {
      ...current,
      count: current.count + 1
    };
    this.buckets.set(input.key, next);
    return next;
  }
})();
