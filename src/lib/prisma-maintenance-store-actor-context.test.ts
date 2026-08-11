import { beforeEach, describe, expect, it, vi } from "vitest";

type Candidate = { readonly id?: string; readonly key?: string; readonly userId?: string };
type FindMany = (input: unknown) => Promise<readonly Candidate[]>;
type ContextInput = {
  readonly actor: { readonly id: string | null; readonly role: string };
  readonly operation: (transaction: TransactionClient) => Promise<unknown>;
};
type TransactionClient = {
  readonly csrfToken: { readonly findMany: FindMany };
  readonly rateLimitBucket: { readonly findMany: FindMany };
  readonly session: { readonly findMany: FindMany };
  readonly user: { readonly findMany: FindMany };
  readonly userSanction: { readonly findMany: FindMany };
};

const storeMocks = vi.hoisted(() => {
  const transactionClient = {
    csrfToken: { findMany: vi.fn<FindMany>() },
    rateLimitBucket: { findMany: vi.fn<FindMany>() },
    session: { findMany: vi.fn<FindMany>() },
    user: { findMany: vi.fn<FindMany>() },
    userSanction: { findMany: vi.fn<FindMany>() }
  } satisfies TransactionClient;
  const topLevelRead = vi.fn(() => {
    throw new Error("protected model reads must use a database context transaction");
  });
  const withDatabaseContext = vi.fn(async (input: ContextInput) => input.operation(transactionClient));

  return {
    topLevelRead,
    transactionClient,
    withDatabaseContext,
    withDatabaseMutation: vi.fn(async (input: ContextInput) => input.operation(transactionClient))
  };
});

vi.mock("./db", () => ({
  prisma: {
    csrfToken: { findMany: storeMocks.topLevelRead },
    rateLimitBucket: { findMany: storeMocks.topLevelRead },
    session: { findMany: storeMocks.topLevelRead },
    user: { findMany: storeMocks.topLevelRead },
    userSanction: { findMany: storeMocks.topLevelRead }
  }
}));

vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  userMutationLockKey: (userId: string) => `user:${userId}`,
  withDatabaseContext: storeMocks.withDatabaseContext,
  withDatabaseMutation: storeMocks.withDatabaseMutation
}));

import { prismaMaintenanceCleanupStore } from "./prisma-maintenance-store";

const now = new Date("2026-08-10T00:00:00.000Z");

describe("prisma maintenance candidate reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.transactionClient.csrfToken.findMany.mockResolvedValue([]);
    storeMocks.transactionClient.rateLimitBucket.findMany.mockResolvedValue([]);
    storeMocks.transactionClient.session.findMany.mockResolvedValue([]);
    storeMocks.transactionClient.user.findMany.mockResolvedValue([]);
    storeMocks.transactionClient.userSanction.findMany.mockResolvedValue([]);
  });

  it.each([
    ["CSRF tokens", prismaMaintenanceCleanupStore.deleteExpiredCsrfTokens, storeMocks.transactionClient.csrfToken.findMany],
    ["rate-limit buckets", prismaMaintenanceCleanupStore.deleteExpiredRateLimitBuckets, storeMocks.transactionClient.rateLimitBucket.findMany],
    ["sessions", prismaMaintenanceCleanupStore.deleteExpiredSessions, storeMocks.transactionClient.session.findMany],
    ["users", prismaMaintenanceCleanupStore.releaseExpiredRestrictions, storeMocks.transactionClient.user.findMany],
    ["user sanctions", prismaMaintenanceCleanupStore.revokeExpiredSanctions, storeMocks.transactionClient.userSanction.findMany]
  ] as const)("uses SYSTEM context for %s candidates without a top-level protected read", async (_name, expire, findMany) => {
    await expire(now);

    expect(findMany).toHaveBeenCalledOnce();
    expect(storeMocks.topLevelRead).not.toHaveBeenCalled();
    expect(storeMocks.withDatabaseContext).toHaveBeenCalledOnce();
    expect(storeMocks.withDatabaseContext.mock.calls[0]?.[0]?.actor).toEqual({ id: null, role: "SYSTEM" });
  });
});
