import { describe, expect, it } from "vitest";

import {
  decideDiscordRemoteVerification,
  evaluateDiscordOperationFence,
  getDiscordRepairActions,
  type DiscordRemoteVerificationState
} from "./discord-operations-repair-policy";

describe("Discord operations repair policy", () => {
  it.each([
    [
      { ambiguity: "definite_non_accepting", attemptsExhausted: false, kind: "initial_send", status: "RETRY" },
      ["RETRY"]
    ],
    [
      { kind: "initial_send", status: "PENDING_REVIEW", verification: "NOT_STARTED" },
      ["VERIFY_REMOTE"]
    ],
    [{ kind: "source_sync", sourceMessageId: "message", status: "REVISION_LAG" }, ["SYNC"]],
    [{ kind: "source_controls", sourceMessageId: "message", status: "STALE" }, ["REMOVE_CONTROLS"]],
    [
      { kind: "unresolved", nonceTombstoneRetained: true, status: "EXHAUSTED" },
      ["ABANDON"]
    ],
    [{ kind: "healthy" }, []]
  ] as const)("returns only eligible actions for %#", (state, actions) => {
    expect(getDiscordRepairActions(state)).toEqual(actions);
  });

  it.each([
    "ERROR",
    "MULTIPLE",
    "PARTIAL",
    "ZERO_COMPLETE",
    "ZERO_PARTIAL"
  ] satisfies readonly DiscordRemoteVerificationState[])(
    "keeps %s non-claimable without retry or tombstone deletion",
    (state) => {
      expect(decideDiscordRemoteVerification({ messageId: null, state })).toEqual({
        canDeleteTombstone: false,
        canRetryPost: false,
        kind: "continue_review"
      });
    }
  );

  it("binds exactly one remote match without enabling another POST", () => {
    expect(decideDiscordRemoteVerification({ messageId: "message-1", state: "UNIQUE" })).toEqual({
      canDeleteTombstone: false,
      canRetryPost: false,
      kind: "bind_message",
      messageId: "message-1"
    });
  });

  it.each(["CLAIM", "INITIAL_POST", "MUTATION", "SOURCE_PATCH"] as const)(
    "fences %s while disabled, draining, or on a stale epoch",
    (stage) => {
      expect(evaluateDiscordOperationFence({
        control: { enabled: false, epoch: 4, pendingRemoteCleanup: false },
        expectedEpoch: 4,
        stage
      })).toEqual({ kind: "disabled" });
      expect(evaluateDiscordOperationFence({
        control: { enabled: true, epoch: 4, pendingRemoteCleanup: true },
        expectedEpoch: 4,
        stage
      })).toEqual({ kind: "draining" });
      expect(evaluateDiscordOperationFence({
        control: { enabled: true, epoch: 5, pendingRemoteCleanup: false },
        expectedEpoch: 4,
        stage
      })).toEqual({ actualEpoch: 5, expectedEpoch: 4, kind: "stale_epoch" });
    }
  );
});
