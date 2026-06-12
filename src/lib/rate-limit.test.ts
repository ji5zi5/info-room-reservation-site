import { describe, expect, it } from "vitest";

import { checkRateLimit, rateLimitKey } from "./rate-limit";
import type { RateLimitBucketRecord, RateLimitStore } from "./rate-limit";

class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucketRecord>();

  public async increment(input: {
    readonly key: string;
    readonly now: Date;
    readonly windowMs: number;
  }): Promise<RateLimitBucketRecord> {
    const existing = this.buckets.get(input.key);
    if (!existing || existing.expiresAt.getTime() <= input.now.getTime()) {
      const created = {
        count: 1,
        expiresAt: new Date(input.now.getTime() + input.windowMs),
        key: input.key,
        windowStart: input.now
      };
      this.buckets.set(input.key, created);
      return created;
    }

    const updated = {
      ...existing,
      count: existing.count + 1
    };
    this.buckets.set(input.key, updated);
    return updated;
  }
}

describe("rate limit policy", () => {
  it("allows requests under the configured limit", async () => {
    const now = new Date("2026-06-12T04:00:00.000Z");
    const store = new MemoryRateLimitStore();

    const first = await checkRateLimit({
      now,
      rules: [{ key: "login:a", limit: 2, windowMs: 60_000 }],
      store
    });
    const second = await checkRateLimit({
      now,
      rules: [{ key: "login:a", limit: 2, windowMs: 60_000 }],
      store
    });

    expect(first).toEqual({ kind: "allowed", remaining: 1, resetAt: new Date("2026-06-12T04:01:00.000Z") });
    expect(second).toEqual({ kind: "allowed", remaining: 0, resetAt: new Date("2026-06-12T04:01:00.000Z") });
  });

  it("blocks requests that exceed the configured limit", async () => {
    const now = new Date("2026-06-12T04:00:00.000Z");
    const store = new MemoryRateLimitStore();
    const rules = [{ key: "reservation:user-1", limit: 1, windowMs: 60_000 }];

    await checkRateLimit({ now, rules, store });
    const result = await checkRateLimit({ now, rules, store });

    expect(result).toEqual({ kind: "blocked", limit: 1, resetAt: new Date("2026-06-12T04:01:00.000Z") });
  });

  it("tracks independent hashed keys separately", async () => {
    const now = new Date("2026-06-12T04:00:00.000Z");
    const store = new MemoryRateLimitStore();
    const firstKey = rateLimitKey(["login", "127.0.0.1", "student-a"]);
    const secondKey = rateLimitKey(["login", "127.0.0.1", "student-b"]);

    await checkRateLimit({ now, rules: [{ key: firstKey, limit: 1, windowMs: 60_000 }], store });
    const result = await checkRateLimit({
      now,
      rules: [{ key: secondKey, limit: 1, windowMs: 60_000 }],
      store
    });

    expect(result.kind).toBe("allowed");
    expect(firstKey).not.toContain("student-a");
    expect(secondKey).not.toContain("student-b");
    expect(firstKey).not.toBe(secondKey);
  });

  it("resets a bucket after the window expires", async () => {
    const store = new MemoryRateLimitStore();
    const rules = [{ key: "admin:destructive", limit: 1, windowMs: 60_000 }];

    await checkRateLimit({ now: new Date("2026-06-12T04:00:00.000Z"), rules, store });
    const result = await checkRateLimit({ now: new Date("2026-06-12T04:01:00.000Z"), rules, store });

    expect(result).toEqual({ kind: "allowed", remaining: 0, resetAt: new Date("2026-06-12T04:02:00.000Z") });
  });
});
