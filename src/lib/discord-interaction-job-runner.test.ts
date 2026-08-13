import { describe, expect, it, vi } from "vitest";

import {
  runDiscordInteractionJobs,
  type DiscordInteractionJobClaim,
  type DiscordInteractionJobStore
} from "./discord-interaction-job-runner";

const now = new Date("2026-08-13T00:00:00.000Z");

describe("Discord interaction job runner", () => {
  it("moves an enabled current-epoch claim to succeeded", async () => {
    // Given: one current claim and a successful command dispatcher.
    const fixture = runnerFixture(claim(1));
    const dispatch = vi.fn().mockResolvedValue({ kind: "succeeded", terminalResult: { outcome: "accepted" } });

    // When: the worker drains its claim batch.
    const result = await runDiscordInteractionJobs({ dispatch, now, store: fixture.store });

    // Then: callers observe a terminal success and the persisted terminal result.
    expect(result).toEqual({ abandoned: 0, claimed: 1, retried: 0, stale: 0, succeeded: 1 });
    expect(fixture.state).toEqual({ status: "SUCCEEDED", terminalResult: { outcome: "accepted" } });
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 5],
    [4, 15],
    [5, 30],
    [6, 60],
    [7, 60]
  ])("schedules resulting attempt %i at the exact %i-minute retry", async (attempts, delayMinutes) => {
    // Given: a claim whose dispatch has a retryable, redacted failure.
    const fixture = runnerFixture(claim(attempts));

    // When: processing records that failure.
    await runDiscordInteractionJobs({
      dispatch: async () => ({ errorCode: "discord_5xx", errorType: "UPSTREAM", kind: "retryable_failure" }),
      now,
      store: fixture.store
    });

    // Then: persisted state exposes the exact retry instant for the resulting attempt.
    expect(fixture.state).toEqual({
      errorCode: "discord_5xx",
      errorType: "UPSTREAM",
      nextAttemptAt: new Date(now.getTime() + delayMinutes * 60_000),
      status: "RETRY"
    });
  });

  it("abandons the poison job on its eighth failed attempt", async () => {
    // Given: a claim on attempt eight.
    const fixture = runnerFixture(claim(8));

    // When: dispatch fails retryably again.
    const result = await runDiscordInteractionJobs({
      dispatch: async () => ({ errorCode: "discord_timeout", errorType: "TIMEOUT", kind: "retryable_failure" }),
      now,
      store: fixture.store
    });

    // Then: no ninth delivery is scheduled.
    expect(result.abandoned).toBe(1);
    expect(fixture.state).toEqual({
      errorCode: "discord_timeout",
      errorType: "TIMEOUT",
      nextAttemptAt: null,
      status: "ABANDONED"
    });
  });

  it("rejects a disabled or stale epoch before command dispatch", async () => {
    // Given: a claimed command whose control epoch is no longer dispatchable.
    const fixture = runnerFixture(claim(1), false);
    const dispatch = vi.fn();

    // When: processing rechecks control immediately before dispatch.
    const result = await runDiscordInteractionJobs({ dispatch, now, store: fixture.store });

    // Then: command code never runs and the job becomes stale.
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.stale).toBe(1);
    expect(fixture.state).toEqual({ status: "STALE", terminalResult: { code: "discord_control_stale" } });
  });

  it("redacts a thrown worker error to code and type", async () => {
    // Given: an exception containing prohibited transport secrets.
    const fixture = runnerFixture(claim(1));

    // When: dispatch throws instead of returning a typed outcome.
    await runDiscordInteractionJobs({
      dispatch: async () => { throw new TypeError("token=secret raw-body=private 203.0.113.4"); },
      now,
      store: fixture.store
    });

    // Then: persisted state contains no message, token, body, IP, or role snapshot.
    expect(fixture.state).toEqual({
      errorCode: "unexpected_dispatch_error",
      errorType: "TypeError",
      nextAttemptAt: new Date(now.getTime() + 60_000),
      status: "RETRY"
    });
    expect(JSON.stringify(fixture.state)).not.toMatch(/secret|raw-body|203\.0\.113\.4|role/iu);
  });
});

function claim(attempts: number): DiscordInteractionJobClaim {
  return {
    attempts,
    claimId: "claim-1",
    commandDigest: "sha256:command",
    discordActorId: "discord-admin",
    interactionId: "interaction-1",
    intent: "accept",
    ipHash: "sha256:ip",
    localActorId: "admin-1",
    renderedEpoch: 7,
    reservationId: "reservation-1",
    sourceChannelId: "channel-1",
    sourceGuildId: "guild-1",
    sourceMessageId: "message-1"
  };
}

function runnerFixture(job: DiscordInteractionJobClaim, dispatchAllowed = true): {
  readonly state: Record<string, unknown>;
  readonly store: DiscordInteractionJobStore;
} {
  const state: Record<string, unknown> = {};
  return {
    state,
    store: {
      claim: async () => [job],
      completeFailure: async (input) => { Object.assign(state, input.result); },
      completeStale: async (input) => { Object.assign(state, { status: "STALE", terminalResult: input.terminalResult }); },
      completeSuccess: async (input) => { Object.assign(state, { status: "SUCCEEDED", terminalResult: input.terminalResult }); },
      isDispatchAllowed: async () => dispatchAllowed
    }
  };
}
