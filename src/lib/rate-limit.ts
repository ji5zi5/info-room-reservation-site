import { createHash } from "node:crypto";

export type RateLimitRule = {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
};

export type RateLimitBucketRecord = {
  readonly count: number;
  readonly expiresAt: Date;
  readonly key: string;
  readonly windowStart: Date;
};

export interface RateLimitStore {
  readonly increment: (input: {
    readonly key: string;
    readonly now: Date;
    readonly windowMs: number;
  }) => Promise<RateLimitBucketRecord>;
}

export type RateLimitResult =
  | {
      readonly kind: "allowed";
      readonly remaining: number;
      readonly resetAt: Date;
    }
  | {
      readonly kind: "blocked";
      readonly limit: number;
      readonly resetAt: Date;
    };

export type RateLimitBlockedResult = Extract<RateLimitResult, { readonly kind: "blocked" }>;

export async function checkRateLimit(input: {
  readonly now: Date;
  readonly rules: readonly RateLimitRule[];
  readonly store: RateLimitStore;
}): Promise<RateLimitResult> {
  let remaining = Number.MAX_SAFE_INTEGER;
  let resetAt: Date | null = null;

  for (const rule of input.rules) {
    const bucket = await input.store.increment({
      key: rule.key,
      now: input.now,
      windowMs: rule.windowMs
    });

    if (bucket.count > rule.limit) {
      return { kind: "blocked", limit: rule.limit, resetAt: bucket.expiresAt };
    }

    remaining = Math.min(remaining, rule.limit - bucket.count);
    resetAt = earliestReset(resetAt, bucket.expiresAt);
  }

  return { kind: "allowed", remaining, resetAt: resetAt ?? input.now };
}

export function rateLimitKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function earliestReset(current: Date | null, candidate: Date): Date {
  if (!current || candidate.getTime() < current.getTime()) {
    return candidate;
  }
  return current;
}
