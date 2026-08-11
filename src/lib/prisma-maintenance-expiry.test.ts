import { beforeEach, describe, expect, it, vi } from "vitest";

type Candidate = { readonly id?: string; readonly key?: string; readonly userId?: string };
type FindMany = (input: unknown) => Promise<readonly Candidate[]>;
type DeleteMany = (input: unknown) => Promise<{ readonly count: number }>;
type UpdateMany = (input: unknown) => Promise<{ readonly count: number }>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly csrfToken: { readonly deleteMany: DeleteMany; readonly findMany: FindMany };
  readonly rateLimitBucket: { readonly deleteMany: DeleteMany; readonly findMany: FindMany };
  readonly session: { readonly deleteMany: DeleteMany; readonly findMany: FindMany };
  readonly user: { readonly findMany: FindMany; readonly updateMany: UpdateMany };
  readonly userSanction: { readonly findMany: FindMany; readonly updateMany: UpdateMany };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;

const prismaMocks = vi.hoisted(() => {
  const rawCalls: Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }> = [];
  const transactionClient = {
    async $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<number> {
      rawCalls.push({ strings: [...strings], values });
      return 1;
    },
    csrfToken: { deleteMany: vi.fn<DeleteMany>(), findMany: vi.fn<FindMany>() },
    rateLimitBucket: { deleteMany: vi.fn<DeleteMany>(), findMany: vi.fn<FindMany>() },
    session: { deleteMany: vi.fn<DeleteMany>(), findMany: vi.fn<FindMany>() },
    user: { findMany: vi.fn<FindMany>(), updateMany: vi.fn<UpdateMany>() },
    userSanction: { findMany: vi.fn<FindMany>(), updateMany: vi.fn<UpdateMany>() }
  } satisfies TransactionClient;

  return {
    rawCalls,
    transaction: vi.fn<PrismaTransaction>(async (operation) => operation(transactionClient)),
    transactionClient
  };
});

vi.mock("./db", () => ({
  prisma: {
    $transaction: prismaMocks.transaction
  }
}));

import { prismaMaintenanceCleanupStore } from "./prisma-maintenance-store";

const now = new Date("2026-06-16T04:30:00.000Z");
const ids = Array.from({ length: 101 }, (_, index) => `id-${index.toString().padStart(3, "0")}`);

describe("prisma maintenance bounded expiry batches", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMocks.rawCalls.length = 0;
    prismaMocks.transaction.mockImplementation(async (operation) => operation(prismaMocks.transactionClient));
    prismaMocks.transactionClient.csrfToken.deleteMany.mockResolvedValue({ count: 100 });
    prismaMocks.transactionClient.rateLimitBucket.deleteMany.mockResolvedValue({ count: 100 });
    prismaMocks.transactionClient.session.deleteMany.mockResolvedValue({ count: 100 });
    prismaMocks.transactionClient.user.updateMany.mockResolvedValue({ count: 100 });
    prismaMocks.transactionClient.userSanction.updateMany.mockResolvedValue({ count: 100 });
  });

  it.each([
    ["sessions", prismaMocks.transactionClient.session.findMany, prismaMaintenanceCleanupStore.deleteExpiredSessions, "session", "id"],
    ["CSRF tokens", prismaMocks.transactionClient.csrfToken.findMany, prismaMaintenanceCleanupStore.deleteExpiredCsrfTokens, "csrfToken", "id"],
    ["rate limits", prismaMocks.transactionClient.rateLimitBucket.findMany, prismaMaintenanceCleanupStore.deleteExpiredRateLimitBuckets, "rateLimitBucket", "key"]
  ] as const)("deletes only currently expired records among the first 100 ordered %s candidates", async (_name, findMany, expire, model, key) => {
    findMany.mockResolvedValue(ids.map((id) => ({ [key]: id })));

    await expect(expire(now)).resolves.toEqual({ hasMore: true, processedCount: 100, remainingLowerBound: 1 });

    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ expiresAt: "asc" }, { [key]: "asc" }],
      select: { [key]: true },
      take: 101,
      where: { expiresAt: { lte: now } }
    });
    const deleteMany = prismaMocks.transactionClient[model].deleteMany;
    expect(deleteMany).toHaveBeenCalledWith({
      where: { [key]: { in: ids.slice(0, 100) }, expiresAt: { lte: now } }
    });
  });

  it("updates only the first 100 ordered restriction user IDs and preserves advisory locks", async () => {
    prismaMocks.transactionClient.user.findMany.mockResolvedValue(ids.map((id) => ({ id })));

    await expect(prismaMaintenanceCleanupStore.releaseExpiredRestrictions(now)).resolves.toEqual({
      hasMore: true,
      processedCount: 100,
      remainingLowerBound: 1
    });

    expect(prismaMocks.transactionClient.user.findMany).toHaveBeenCalledWith({
      orderBy: [{ restrictedUntil: "asc" }, { id: "asc" }],
      select: { id: true },
      take: 101,
      where: { bookingStatus: "RESTRICTED", restrictedUntil: { lte: now } }
    });
    expect(prismaMocks.transactionClient.user.updateMany).toHaveBeenCalledWith({
      data: { bookingStatus: "ACTIVE", restrictedUntil: null, restrictionReason: null },
      where: {
        bookingStatus: "RESTRICTED",
        id: { in: ids.slice(0, 100) },
        restrictedUntil: { lte: now }
      }
    });
    expect(lockValues()).toHaveLength(100);
  });

  it("updates 100 sanction primary keys when candidate user IDs repeat", async () => {
    prismaMocks.transactionClient.userSanction.findMany.mockResolvedValue(ids.map((id) => ({ id, userId: "repeated-user" })));

    await expect(prismaMaintenanceCleanupStore.revokeExpiredSanctions(now)).resolves.toEqual({
      hasMore: true,
      processedCount: 100,
      remainingLowerBound: 1
    });

    expect(prismaMocks.transactionClient.userSanction.findMany).toHaveBeenCalledWith({
      orderBy: [{ endsAt: "asc" }, { id: "asc" }],
      select: { id: true, userId: true },
      take: 101,
      where: { endsAt: { lte: now }, status: "ACTIVE" }
    });
    expect(prismaMocks.transactionClient.userSanction.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: now, revokedById: null, revokedReason: "기간 만료", status: "REVOKED" },
      where: {
        endsAt: { lte: now },
        id: { in: ids.slice(0, 100) },
        status: "ACTIVE"
      }
    });
    expect(lockValues()).toEqual([["user:repeated-user"]]);
  });
});

function lockValues(): readonly (readonly unknown[])[] {
  return prismaMocks.rawCalls
    .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
    .map((call) => call.values);
}
