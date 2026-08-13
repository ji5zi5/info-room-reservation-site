import { describe, expect, it } from "vitest";

import {
  OPERATIONAL_JOB_POLICIES,
  evaluateOperationalJobReadiness,
  type OperationalJobState
} from "./operational-jobs";

const now = new Date("2026-06-12T07:25:00.000Z");

describe("operational job readiness", () => {
  it("schedules both Discord workers every minute", () => {
    expect(OPERATIONAL_JOB_POLICIES.DISCORD_INTERACTIONS).toEqual({
      intervalMs: 60_000,
      timeoutMs: 2 * 60_000
    });
    expect(OPERATIONAL_JOB_POLICIES.DISCORD_RESERVATION_OUTBOX).toEqual({
      intervalMs: 60_000,
      timeoutMs: 2 * 60_000
    });
  });

  it("excludes an explicitly disabled job", () => {
    expect(
      evaluateOperationalJobReadiness({
        enabled: false,
        now,
        policy: OPERATIONAL_JOB_POLICIES.CLOSED_PERIOD_NOTIFICATIONS,
        state: null
      })
    ).toEqual({ code: "disabled", status: "ok" });
  });

  it("reports never-run enabled jobs as unready", () => {
    expect(
      evaluateOperationalJobReadiness({
        enabled: true,
        now,
        policy: OPERATIONAL_JOB_POLICIES.CLOSED_PERIOD_NOTIFICATIONS,
        state: null
      })
    ).toEqual({ code: "never_run", status: "unready" });
  });

  it("distinguishes a normal running job from a timed-out run", () => {
    expect(readiness(runningState("2026-06-12T07:24:00.000Z"))).toEqual({
      code: "running",
      status: "degraded"
    });
    expect(readiness(runningState("2026-06-12T07:22:59.000Z"))).toEqual({
      code: "running_timeout",
      status: "unready"
    });
  });

  it("degrades after one failure but fails readiness after two", () => {
    expect(readiness(failedState(1))).toEqual({ code: "last_attempt_failed", status: "degraded" });
    expect(readiness(failedState(2))).toEqual({ code: "repeated_failures", status: "unready" });
  });

  it("fails readiness when the last success is older than three intervals", () => {
    expect(
      readiness({
        ...succeededState,
        lastSuccessAt: new Date("2026-06-12T07:21:59.000Z")
      })
    ).toEqual({ code: "stale", status: "unready" });
  });
});

function readiness(state: OperationalJobState) {
  return evaluateOperationalJobReadiness({
    enabled: true,
    now,
    policy: OPERATIONAL_JOB_POLICIES.CLOSED_PERIOD_NOTIFICATIONS,
    state
  });
}

const succeededState: OperationalJobState = {
  consecutiveFailures: 0,
  finishedAt: new Date("2026-06-12T07:24:00.000Z"),
  lastAttemptAt: new Date("2026-06-12T07:24:00.000Z"),
  lastSuccessAt: new Date("2026-06-12T07:24:00.000Z"),
  startedAt: new Date("2026-06-12T07:23:59.000Z"),
  status: "SUCCEEDED"
};

function runningState(startedAt: string): OperationalJobState {
  return {
    ...succeededState,
    finishedAt: null,
    startedAt: new Date(startedAt),
    status: "RUNNING"
  };
}

function failedState(consecutiveFailures: number): OperationalJobState {
  return {
    ...succeededState,
    consecutiveFailures,
    lastAttemptAt: new Date("2026-06-12T07:24:30.000Z"),
    status: "FAILED"
  };
}
