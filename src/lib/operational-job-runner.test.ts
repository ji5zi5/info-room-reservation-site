import { describe, expect, it, vi } from "vitest";

import {
  runOperationalJob,
  type OperationalJobRecord,
  type OperationalJobStore
} from "./operational-job-runner";

const startedAt = new Date("2026-06-12T07:25:00.000Z");
const finishedAt = new Date("2026-06-12T07:25:02.000Z");

describe("operational job runner", () => {
  it("records a successful run with aggregate backlog metrics", async () => {
    const store = memoryStore();

    const result = await runOperationalJob({
      clock: () => finishedAt,
      job: "CLOSED_PERIOD_NOTIFICATIONS",
      now: startedAt,
      operation: async () => ({
        backlogCount: 3,
        kind: "succeeded",
        oldestBacklogAt: new Date("2026-06-10T00:00:00.000Z"),
        result: { processed: 2 },
        value: { processed: 2 }
      }),
      store
    });

    expect(result).toMatchObject({ kind: "succeeded", value: { processed: 2 } });
    expect(store.current).toMatchObject({
      backlogCount: 3,
      consecutiveFailures: 0,
      durationMs: 2_000,
      lastSuccessAt: finishedAt,
      status: "SUCCEEDED"
    });
  });

  it("does not execute an overlapping run", async () => {
    const operation = vi.fn();
    const store = memoryStore({ refuseStart: true });

    await expect(
      runOperationalJob({
        job: "MAINTENANCE",
        now: startedAt,
        operation,
        store
      })
    ).resolves.toEqual({ kind: "already_running" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("records expected and unexpected failures without persisting error text", async () => {
    const expectedStore = memoryStore();
    const unexpectedStore = memoryStore();

    await expect(
      runOperationalJob({
        clock: () => finishedAt,
        job: "CLOSED_PERIOD_NOTIFICATIONS",
        now: startedAt,
        operation: async () => ({
          backlogCount: 1,
          failureCode: "discord_delivery_failed",
          kind: "failed",
          oldestBacklogAt: startedAt,
          result: { failed: 1 },
          value: { failed: 1 }
        }),
        store: expectedStore
      })
    ).resolves.toMatchObject({ failureCode: "discord_delivery_failed", kind: "failed" });
    await expect(
      runOperationalJob({
        clock: () => finishedAt,
        job: "MAINTENANCE",
        now: startedAt,
        operation: async () => {
          throw new Error("contains-sensitive-runtime-detail");
        },
        store: unexpectedStore
      })
    ).resolves.toEqual({ failureCode: "unexpected_error", kind: "failed" });

    expect(expectedStore.current).toMatchObject({ consecutiveFailures: 1, status: "FAILED" });
    expect(unexpectedStore.current?.result).toBe('{"status":"unexpected_error"}');
    expect(unexpectedStore.current?.result).not.toContain("contains-sensitive-runtime-detail");
  });

  it("records maintenance backlog as a failed run with its nonzero lower bound", async () => {
    const store = memoryStore();

    const result = await runOperationalJob({
      clock: () => finishedAt,
      job: "MAINTENANCE",
      now: startedAt,
      operation: async () => ({
        backlogCount: 1,
        failureCode: "maintenance_backlog_remaining",
        kind: "failed",
        oldestBacklogAt: null,
        result: { backlogCount: 1, sessionsDeleted: 1_000 },
        value: { backlogCount: 1, sessionsDeleted: 1_000 }
      }),
      store
    });

    expect(result).toEqual({
      failureCode: "maintenance_backlog_remaining",
      kind: "failed",
      value: { backlogCount: 1, sessionsDeleted: 1_000 }
    });
    expect(store.current).toMatchObject({
      backlogCount: 1,
      failureCode: "maintenance_backlog_remaining",
      status: "FAILED"
    });
  });

  it("records unexpected_error when retention throws after backlog detection", async () => {
    const store = memoryStore();
    let backlogDetected = false;

    const result = await runOperationalJob({
      clock: () => finishedAt,
      job: "MAINTENANCE",
      now: startedAt,
      operation: async () => {
        backlogDetected = true;
        throw new Error("retention failed after backlog detection");
      },
      store
    });

    expect(backlogDetected).toBe(true);
    expect(result).toEqual({ failureCode: "unexpected_error", kind: "failed" });
    expect(store.current).toMatchObject({
      backlogCount: 0,
      failureCode: "unexpected_error",
      result: '{"status":"unexpected_error"}',
      status: "FAILED"
    });
  });
});

function memoryStore(input: { readonly refuseStart?: boolean } = {}): OperationalJobStore & {
  readonly current: OperationalJobRecord | null;
} {
  let current: OperationalJobRecord | null = null;
  return {
    async finish(run) {
      if (!current) {
        throw new Error("missing job claim");
      }
      current = {
        ...current,
        backlogCount: run.backlogCount,
        consecutiveFailures: run.succeeded ? 0 : current.consecutiveFailures + 1,
        durationMs: run.durationMs,
        failureCode: run.failureCode,
        finishedAt: run.finishedAt,
        lastSuccessAt: run.succeeded ? run.finishedAt : current.lastSuccessAt,
        oldestBacklogAt: run.oldestBacklogAt,
        result: run.result,
        status: run.succeeded ? "SUCCEEDED" : "FAILED"
      };
      return current;
    },
    get current() {
      return current;
    },
    async tryStart(run) {
      if (input.refuseStart) {
        return null;
      }
      current = {
        backlogCount: 0,
        consecutiveFailures: 0,
        durationMs: null,
        failureCode: null,
        finishedAt: null,
        job: run.job,
        lastAttemptAt: run.startedAt,
        lastSuccessAt: null,
        oldestBacklogAt: null,
        result: null,
        startedAt: run.startedAt,
        status: "RUNNING"
      };
      return current;
    }
  };
}
