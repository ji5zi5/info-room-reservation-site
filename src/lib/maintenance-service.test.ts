import { describe, expect, it, vi } from "vitest";

import {
  createDiscordMessageRetentionCleanup,
  runMaintenanceCleanup,
  type DiscordMaintenanceCleanupStore,
  type DiscordMessageRetentionCandidate,
  type DiscordMessageRetentionRepository,
  type MaintenanceCleanupStore
} from "./maintenance-service";
import type { DiscordBotClient } from "./discord-bot";

const now = new Date("2026-06-14T12:00:00.000Z");
const categories = [
  ["Discord messages", "deleteExpiredMessages", "discordMessagesDeleted"],
  ["Discord interaction jobs", "deleteExpiredInteractionJobs", "discordInteractionJobsDeleted"],
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

  it.each(categories.slice(3))("fails fast when %s expiry throws", async (_name, method) => {
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

  it("keeps Discord deletion failures in backlog and deletes receipts only afterward", async () => {
    // Given: remote message cleanup retains one pointer without requesting another batch.
    const calls: string[] = [];
    const store = storeWithOverrides(calls, {
      deleteExpiredMessages: async () => {
        calls.push("deleteExpiredMessages");
        return { hasMore: false, processedCount: 0, remainingLowerBound: 1 };
      }
    });

    // When: maintenance runs.
    const result = await runCleanup(store);

    // Then: the backlog is surfaced and receipt deletion remains after message cleanup.
    expect(result.backlogCount).toBe(1);
    expect(calls.slice(0, 3)).toEqual([
      "deleteExpiredMessages",
      "deleteExpiredInteractionJobs",
      "deleteExpiredInteractionReceipts"
    ]);
    expect(result.discordStages.messages).toEqual({
      backlogCount: 1,
      failureCode: null,
      processedCount: 0
    });
  });

  it("isolates a Discord cleanup-stage exception and reports its failure code", async () => {
    const calls: string[] = [];
    const store = storeWithOverrides(calls, {
      deleteExpiredInteractionJobs: async () => {
        calls.push("deleteExpiredInteractionJobs");
        throw new Error("database unavailable");
      }
    });

    const result = await runCleanup(store);

    expect(result.discordStages.interactionJobs).toEqual({
      backlogCount: 1,
      failureCode: "discord_interaction_jobs_cleanup_failed",
      processedCount: 0
    });
    expect(result.discordStages.messages.failureCode).toBeNull();
    expect(result.discordStages.interactionReceipts.failureCode).toBeNull();
    expect(calls).toContain("retention");
  });
});

describe("Discord message retention", () => {
  it("bounds one message-retention batch to one hundred candidates", async () => {
    const fixture = retentionFixture();
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      ...fixture.candidate(),
      kind: "local" as const,
      reservationId: `reservation-${index}`
    }));
    fixture.repository.findExpiredCandidates.mockResolvedValue(candidates);

    const result = await createDiscordMessageRetentionCleanup(fixture.dependencies)(now);

    expect(result).toEqual({ hasMore: true, processedCount: 100, remainingLowerBound: 1 });
    expect(fixture.repository.deleteLocalCandidate).toHaveBeenCalledTimes(100);
  });

  it("deletes a known remote pointer before reducing its ledger", async () => {
    const events: string[] = [];
    const fixture = retentionFixture(events, { kind: "known", messageId: "known-message" });
    const log = vi.fn();

    const result = await createDiscordMessageRetentionCleanup(fixture.dependencies)(now, {
      log,
      runId: "retention-run"
    });

    expect(result.processedCount).toBe(1);
    expect(events).toEqual(["remote:known-message", "reduce:KNOWN"]);
    expect(fixture.history).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "MAINTENANCE",
      reservationId: "reservation",
      result: "succeeded",
      runId: "retention-run"
    }));
  });

  it("resumes a persisted cursor and remotely deletes a unique match before ledger reduction", async () => {
    const events: string[] = [];
    const fixture = retentionFixture(events);
    fixture.history
      .mockResolvedValueOnce({ kind: "found", messages: fullHistory("match", "nonce") })
      .mockResolvedValueOnce({ kind: "found", messages: [] });
    const cleanup = createDiscordMessageRetentionCleanup(fixture.dependencies);

    const partial = await cleanup(now);
    const complete = await cleanup(now);

    expect(partial).toMatchObject({ failureCode: "discord_retention_scan_partial", processedCount: 0 });
    expect(complete).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 0 });
    expect(fixture.history.mock.calls[1]?.[0]).toMatchObject({ before: "history-99" });
    expect(events.slice(-2)).toEqual(["remote:match", "reduce:UNIQUE"]);
  });

  it("deletes every exact multiple match before recording the security tombstone", async () => {
    const events: string[] = [];
    const fixture = retentionFixture(events);
    fixture.history.mockResolvedValue({
      kind: "found",
      messages: [{ id: "match-1", nonce: "nonce" }, { id: "match-2", nonce: "nonce" }]
    });

    const result = await createDiscordMessageRetentionCleanup(fixture.dependencies)(now);

    expect(result).toMatchObject({ processedCount: 1, remainingLowerBound: 0 });
    expect(events).toEqual(["remote:match-1", "remote:match-2", "reduce:MULTIPLE"]);
  });

  it.each([
    ["ZERO_COMPLETE", { kind: "found", messages: [] }, "discord_retention_zero_match"],
    ["ERROR", { code: "discord_http_429", kind: "retryable_failure" }, "discord_http_429"],
    ["ERROR", { code: "discord_http_500", kind: "terminal_failure" }, "discord_http_500"]
  ] as const)("retains permanent lookup evidence for %s", async (status, response, failureCode) => {
    const fixture = retentionFixture();
    fixture.history.mockResolvedValue(response);

    const result = await createDiscordMessageRetentionCleanup(fixture.dependencies)(now);

    expect(result).toMatchObject({ failureCode, processedCount: 0, remainingLowerBound: 1 });
    expect(fixture.repository.saveScanProgress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status }),
      now
    );
    expect(fixture.repository.reduceToDeletionTombstone).not.toHaveBeenCalled();
  });

  it("retains all lookup evidence when one remote deletion fails", async () => {
    const fixture = retentionFixture();
    fixture.history.mockResolvedValue({ kind: "found", messages: [{ id: "match", nonce: "nonce" }] });
    fixture.remove.mockResolvedValue({ code: "discord_http_500", kind: "failed", message: "failed" });

    const result = await createDiscordMessageRetentionCleanup(fixture.dependencies)(now);

    expect(result).toMatchObject({ failureCode: "discord_http_500", processedCount: 0 });
    expect(fixture.repository.saveScanProgress).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lastErrorCode: "discord_http_500", matchedMessageIds: ["match"] }),
      now
    );
    expect(fixture.repository.reduceToDeletionTombstone).not.toHaveBeenCalled();
  });

  it("does not rescan a permanent complete-zero tombstone or exceed the history cap", async () => {
    const completeZero = retentionFixture([], { continuation: {
      attemptBoundary: "boundary",
      before: "cursor",
      complete: true,
      lastErrorCode: null,
      matchedMessageIds: [],
      pagesScanned: 1,
      status: "ZERO_COMPLETE",
      version: 1
    } });
    const capped = retentionFixture([], { continuation: {
      attemptBoundary: "boundary",
      before: "cursor",
      complete: false,
      lastErrorCode: null,
      matchedMessageIds: ["match"],
      pagesScanned: 10,
      status: "PARTIAL",
      version: 1
    } });

    const zeroResult = await createDiscordMessageRetentionCleanup(completeZero.dependencies)(now);
    const cappedResult = await createDiscordMessageRetentionCleanup(capped.dependencies)(now);

    expect(zeroResult).toMatchObject({ failureCode: "discord_retention_zero_match", processedCount: 0 });
    expect(cappedResult).toMatchObject({ failureCode: "discord_retention_scan_cap", processedCount: 0 });
    expect(completeZero.history).not.toHaveBeenCalled();
    expect(capped.history).not.toHaveBeenCalled();
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
    deleteExpiredInteractionJobs: overrides.deleteExpiredInteractionJobs ?? callBatch("deleteExpiredInteractionJobs", calls, emptyBatch),
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
  return async (value: Date) => {
    calls.push(name);
    return operation(value);
  };
}

function runCleanup(store: CombinedStore) {
  return runMaintenanceCleanup({ discordStore: store, log: () => undefined, now, runId: "run-1", store });
}

function retentionFixture(
  events: string[] = [],
  overrides: Partial<DiscordMessageRetentionCandidate> = {}
) {
  let candidate: DiscordMessageRetentionCandidate = {
    attemptBoundary: "boundary",
    channelId: "channel",
    continuation: null,
    kind: "unknown",
    messageId: null,
    nonce: "nonce",
    reservationId: "reservation",
    updatedAt: new Date("2026-06-13T00:00:00.000Z"),
    ...overrides
  };
  const history = vi.fn();
  const remove = vi.fn<DiscordBotClient["deleteChannelMessage"]>(async ({ messageId }) => {
    events.push(`remote:${messageId}`);
    return { kind: "removed" as const };
  });
  const repository = {
    deleteLocalCandidate: vi.fn(async () => true),
    findExpiredCandidates: vi.fn(async () => [candidate]),
    reduceToDeletionTombstone: vi.fn(async ({ outcome }) => {
      events.push(`reduce:${outcome}`);
      return true;
    }),
    saveScanProgress: vi.fn(async (_candidate, continuation) => {
      candidate = { ...candidate, continuation };
      return true;
    })
  } satisfies DiscordMessageRetentionRepository;
  return {
    candidate: () => candidate,
    dependencies: {
      hasApplicationConfig: () => true,
      history: { listChannelMessagesPage: history },
      log: () => undefined,
      repository,
      transport: { deleteChannelMessage: remove }
    },
    history,
    remove,
    repository
  };
}

function fullHistory(matchId: string, nonce: string) {
  return Array.from({ length: 100 }, (_, index) => ({
    id: index === 0 ? matchId : `history-${index}`,
    nonce: index === 0 ? nonce : null
  }));
}
