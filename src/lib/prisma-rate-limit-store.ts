import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import type { RateLimitBucketRecord, RateLimitStore } from "./rate-limit";

type RateLimitBucketRow = {
  readonly count: number;
  readonly expiresAt: Date;
  readonly key: string;
  readonly windowStart: Date;
};

export const prismaRateLimitStore: RateLimitStore = {
  async increment(input) {
    const expiresAt = new Date(input.now.getTime() + input.windowMs);
    const rows = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.$queryRaw<readonly RateLimitBucketRow[]>`
        INSERT INTO "RateLimitBucket" ("key", "windowStart", "count", "expiresAt", "createdAt", "updatedAt")
        VALUES (${input.key}, ${input.now}, 1, ${expiresAt}, ${input.now}, ${input.now})
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE
            WHEN "RateLimitBucket"."expiresAt" <= ${input.now} THEN 1
            ELSE "RateLimitBucket"."count" + 1
          END,
          "windowStart" = CASE
            WHEN "RateLimitBucket"."expiresAt" <= ${input.now} THEN ${input.now}
            ELSE "RateLimitBucket"."windowStart"
          END,
          "expiresAt" = CASE
            WHEN "RateLimitBucket"."expiresAt" <= ${input.now} THEN ${expiresAt}
            ELSE "RateLimitBucket"."expiresAt"
          END,
          "updatedAt" = ${input.now}
        RETURNING "key", "count", "windowStart", "expiresAt"
      `
    });
    const bucket = rows[0];
    if (!bucket) {
      throw new RateLimitStoreError(input.key);
    }
    return toRateLimitBucket(bucket);
  }
};

export class RateLimitStoreError extends Error {
  public constructor(key: string) {
    super(`Rate limit bucket was not returned for ${key}.`);
    this.name = "RateLimitStoreError";
  }
}

function toRateLimitBucket(row: RateLimitBucketRow): RateLimitBucketRecord {
  return {
    count: row.count,
    expiresAt: row.expiresAt,
    key: row.key,
    windowStart: row.windowStart
  };
}
