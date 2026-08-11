import { beforeEach, describe, expect, it, vi } from "vitest";

type OperationalJobCandidate = {
  readonly backlogCount: number;
  readonly consecutiveFailures: number;
  readonly durationMs: number | null;
  readonly failureCode: string | null;
  readonly finishedAt: Date | null;
  readonly job: string;
  readonly lastAttemptAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly oldestBacklogAt: Date | null;
  readonly result: unknown;
  readonly startedAt: Date;
  readonly status: string;
};
type FindMany = () => Promise<readonly OperationalJobCandidate[]>;
type ContextInput = {
  readonly actor: { readonly id: string | null; readonly role: string };
  readonly operation: (transaction: { readonly operationalJob: { readonly findMany: FindMany } }) => Promise<unknown>;
};

const storeMocks = vi.hoisted(() => {
  const transactionClient = {
    operationalJob: { findMany: vi.fn<FindMany>() }
  };
  const topLevelRead = vi.fn(() => {
    throw new Error("operational job reads must use a database context transaction");
  });
  const withDatabaseContext = vi.fn(async (input: ContextInput) => input.operation(transactionClient));

  return { topLevelRead, transactionClient, withDatabaseContext };
});

vi.mock("./db", () => ({
  prisma: { operationalJob: { findMany: storeMocks.topLevelRead } }
}));

vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: storeMocks.withDatabaseContext,
  withDatabaseMutation: vi.fn()
}));

import { getPrismaOperationalJobs } from "./prisma-operational-job-store";

describe("prisma operational-job readiness reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads operational jobs through SYSTEM context without a top-level protected read", async () => {
    const startedAt = new Date("2026-08-10T00:00:00.000Z");
    storeMocks.transactionClient.operationalJob.findMany.mockResolvedValue([
      {
        backlogCount: 0,
        consecutiveFailures: 0,
        durationMs: 20,
        failureCode: null,
        finishedAt: startedAt,
        job: "MAINTENANCE",
        lastAttemptAt: startedAt,
        lastSuccessAt: startedAt,
        oldestBacklogAt: null,
        result: { processedCount: 0 },
        startedAt,
        status: "SUCCEEDED"
      }
    ]);

    await expect(getPrismaOperationalJobs()).resolves.toEqual([
      expect.objectContaining({ job: "MAINTENANCE", status: "SUCCEEDED" })
    ]);

    expect(storeMocks.transactionClient.operationalJob.findMany).toHaveBeenCalledOnce();
    expect(storeMocks.topLevelRead).not.toHaveBeenCalled();
    expect(storeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(storeMocks.withDatabaseContext.mock.calls[0]?.[0]?.actor).toEqual({ id: null, role: "SYSTEM" });
  });
});
