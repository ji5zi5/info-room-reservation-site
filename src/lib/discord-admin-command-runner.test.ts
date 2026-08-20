import { describe, expect, it, vi } from "vitest";

import {
  runDiscordAdminCommandJobs,
  type DiscordAdminCommandClaim,
  type DiscordAdminCommandJobStore
} from "./discord-admin-command-runner";

const claim: DiscordAdminCommandClaim = {
  attempts: 1,
  claimId: "claim-1",
  commandDigest: "sha256:digest",
  discordActorId: "discord-1",
  draftIntent: "{}",
  executionInteractionId: "interaction-1",
  id: "job-1",
  ipHash: "a".repeat(64),
  localActorId: "admin-1",
  reason: null,
  sourceApplicationId: "application-1",
  sourceChannelId: "channel-1",
  sourceGuildId: "guild-1",
  sourceInteractionId: "source-interaction-1"
};

describe("Discord administrator command runner", () => {
  it("stores a successful terminal result for later delivery", async () => {
    // Given: one acknowledged command job.
    const store = jobStore([claim]);

    // When: the command succeeds.
    const summary = await runDiscordAdminCommandJobs({
      dispatch: vi.fn().mockResolvedValue({
        kind: "succeeded",
        result: { color: 1, description: "ok", fields: [], outcome: "success", title: "done" }
      }),
      now: new Date("2026-08-20T05:00:00.000Z"),
      store
    });

    // Then: it is terminal and queued for result delivery.
    expect(summary).toEqual({ abandoned: 0, claimed: 1, retried: 0, stale: 0, succeeded: 1 });
    expect(store.completeResult).toHaveBeenCalledWith(expect.objectContaining({ status: "SUCCEEDED" }));
  });

  it("backs off a retryable command without losing the claim", async () => {
    // Given: a transient executor failure.
    const store = jobStore([claim]);
    const now = new Date("2026-08-20T05:00:00.000Z");

    // When: the command runner handles it.
    const summary = await runDiscordAdminCommandJobs({
      dispatch: vi.fn().mockResolvedValue({ errorCode: "db_busy", errorType: "DatabaseError", kind: "retryable_failure" }),
      now,
      store
    });

    // Then: the job is retried one minute later.
    expect(summary.retried).toBe(1);
    expect(store.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      nextAttemptAt: new Date("2026-08-20T05:01:00.000Z"),
      result: null,
      status: "RETRY"
    }));
  });

  it("queues a public failure result when a command cannot be retried", async () => {
    const store = jobStore([claim]);

    await runDiscordAdminCommandJobs({
      dispatch: vi.fn().mockResolvedValue({
        errorCode: "invalid_state",
        errorType: "ReservationConflictError",
        kind: "terminal_failure"
      }),
      now: new Date("2026-08-20T05:00:00.000Z"),
      store
    });

    expect(store.completeFailure).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        outcome: "failure",
        title: "처리 실패"
      }),
      status: "ABANDONED"
    }));
  });
});

function jobStore(claims: readonly DiscordAdminCommandClaim[]): DiscordAdminCommandJobStore {
  return {
    claim: vi.fn().mockResolvedValue(claims),
    completeFailure: vi.fn().mockResolvedValue(undefined),
    completeResult: vi.fn().mockResolvedValue(undefined)
  };
}
