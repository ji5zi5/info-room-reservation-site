import { describe, expect, it } from "vitest";

import { runMaintenanceCleanup, type DiscordMaintenanceCleanupStore, type MaintenanceCleanupStore } from "./maintenance-service";

const now = new Date("2026-06-14T12:00:00.000Z");
const categories = [
  ["Discord messages", "deleteExpiredMessages", "discordMessagesDeleted"],
  ["Discord receipts", "deleteExpiredInteractionReceipts", "discordInteractionReceiptsDeleted"],
  ["sessions", "deleteExpiredSessions", "sessionsDeleted"],
  ["CSRF tokens", "deleteExpiredCsrfTokens", "csrfTokensDeleted"],
  ["rate limits", "deleteExpiredRateLimitBuckets", "rateLimitBucketsDeleted"],
  ["restrictions", "releaseExpiredRestrictions", "restrictionsReleased"],
  ["sanctions", "revokeExpiredSanctions", "expiredSanctionsRevoked"]
] as const;

describe("maintenance cleanup service", () => {
  it.each(categories)("drains 250 expired %s in three bounded batches", async (_name, method, resultField) => {
    const { calls, store } = storeWithCategoryTotal(method, 250);

    const result = await runCleanup(store);

    expect(result[resultField]).toBe(250);
    expect(result.backlogCount).toBe(0);
    expect(calls.filter((call) => call === method)).toHaveLength(3);
    expect(calls.at(-1)).toBe("retention");
  });

  it.each(categories.flatMap((category) => [999, 1_000].map((total) => [category, total] as const)))(
    "drains expired records for a category without backlog",
    async ([_name, method, resultField], total) => {
      const { calls, store } = storeWithCategoryTotal(method, total);

      const result = await runCleanup(store);

      expect(result[resultField]).toBe(total);
      expect(result.backlogCount).toBe(0);
      expect(calls.filter((call) => call === method)).toHaveLength(10);
      expect(calls.filter((call) => call === "retention")).toHaveLength(1);
    }
  );

  it.each(categories)("caps 1,001 expired %s at ten batches and reports a lower-bound backlog", async (_name, method, resultField) => {
    const { calls, store } = storeWithCategoryTotal(method, 1_001);

    const result = await runCleanup(store);

    expect(result[resultField]).toBe(1_000);
    expect(result.backlogCount).toBe(1);
    expect(calls.filter((call) => call === method)).toHaveLength(10);
    expect(calls.filter((call) => call === "retention")).toHaveLength(1);
    expect(calls.at(-1)).toBe("retention");
  });

  it.each(categories)("fails fast when %s expiry throws", async (_name, method) => {
    const calls: string[] = [];
    const store = storeWithOverrides(calls, {
      [method]: async () => {
        calls.push(method);
        throw new Error(`failed:${method}`);
      }
    });

    await expect(runCleanup(store)).rejects.toThrow(`failed:${method}`);

    const expectedPrefix = categories.map((category) => category[1]);
    expect(calls).toEqual(expectedPrefix.slice(0, expectedPrefix.indexOf(method) + 1));
    expect(calls).not.toContain("retention");
  });

  it("lets a retention exception win after backlog is detected", async () => {
    const { calls, store } = storeWithCategoryTotal("deleteExpiredSessions", 1_001, true);

    await expect(runCleanup(store)).rejects.toThrow("retention failed");

    expect(calls.filter((call) => call === "deleteExpiredSessions")).toHaveLength(10);
    expect(calls.filter((call) => call === "retention")).toHaveLength(1);
  });
});

type ExpiryMethod = (typeof categories)[number][1];
type CombinedStore = MaintenanceCleanupStore & DiscordMaintenanceCleanupStore;
type StoreOverrides = Partial<Record<ExpiryMethod, CombinedStore[ExpiryMethod]>>;

function storeWithCategoryTotal(method: ExpiryMethod, total: number, failRetention = false): {
  readonly calls: string[];
  readonly store: CombinedStore;
} {
  const calls: string[] = [];
  let remaining = total;
  return {
    calls,
    store: storeWithOverrides(calls, {
      [method]: async () => {
        calls.push(method);
        const candidateCount = Math.min(101, remaining);
        const processedCount = Math.min(100, candidateCount);
        remaining -= processedCount;
        return {
          hasMore: candidateCount > 100,
          processedCount,
          remainingLowerBound: candidateCount > 100 ? 1 : 0
        };
      }
    }, failRetention)
  };
}

function storeWithOverrides(calls: string[], overrides: StoreOverrides, failRetention = false): CombinedStore {
  const emptyBatch = async () => ({ hasMore: false, processedCount: 0, remainingLowerBound: 0 });
  return {
    async applyRetentionPolicy() {
      calls.push("retention");
      if (failRetention) {
        throw new Error("retention failed");
      }
      return {
        counts: {
          adminActionDetails: 0,
          auditDetails: 0,
          departedUserIdentities: 0,
          reservationReasons: 0,
          sanctionReasons: 0
        },
        kind: "disabled",
        policyVersion: "school-policy-v1"
      };
    },
    deleteExpiredCsrfTokens: overrides.deleteExpiredCsrfTokens ?? callBatch("deleteExpiredCsrfTokens", calls, emptyBatch),
    deleteExpiredInteractionReceipts: overrides.deleteExpiredInteractionReceipts ?? callBatch("deleteExpiredInteractionReceipts", calls, emptyBatch),
    deleteExpiredMessages: overrides.deleteExpiredMessages ?? callBatch("deleteExpiredMessages", calls, emptyBatch),
    deleteExpiredRateLimitBuckets: overrides.deleteExpiredRateLimitBuckets ?? callBatch("deleteExpiredRateLimitBuckets", calls, emptyBatch),
    deleteExpiredSessions: overrides.deleteExpiredSessions ?? callBatch("deleteExpiredSessions", calls, emptyBatch),
    releaseExpiredRestrictions: overrides.releaseExpiredRestrictions ?? callBatch("releaseExpiredRestrictions", calls, emptyBatch),
    revokeExpiredSanctions: overrides.revokeExpiredSanctions ?? callBatch("revokeExpiredSanctions", calls, emptyBatch)
  };
}

function callBatch(
  name: ExpiryMethod,
  calls: string[],
  operation: CombinedStore[ExpiryMethod]
): CombinedStore[ExpiryMethod] {
  return async (value) => {
    calls.push(name);
    return operation(value);
  };
}

function runCleanup(store: CombinedStore) {
  return runMaintenanceCleanup({ discordStore: store, now, store });
}
