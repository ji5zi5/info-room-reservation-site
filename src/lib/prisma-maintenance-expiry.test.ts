import { beforeEach, describe, expect, it, vi } from "vitest";

type UserFindMany = (input: unknown) => Promise<readonly { readonly id: string }[]>;
type SanctionFindMany = (input: unknown) => Promise<readonly { readonly userId: string }[]>;
type UpdateMany = (input: unknown) => Promise<{ readonly count: number }>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly user: { readonly updateMany: UpdateMany };
  readonly userSanction: { readonly updateMany: UpdateMany };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;

const prismaMocks = vi.hoisted(() => {
  const rawCalls: Array<{ readonly strings: readonly string[]; readonly values: readonly unknown[] }> = [];
  const transactionClient = {
    async $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<number> {
      rawCalls.push({ strings: [...strings], values });
      return 1;
    },
    user: { updateMany: vi.fn<UpdateMany>(async () => ({ count: 2 })) },
    userSanction: { updateMany: vi.fn<UpdateMany>(async () => ({ count: 3 })) }
  } satisfies TransactionClient;

  return {
    rawCalls,
    sanctionFindMany: vi.fn<SanctionFindMany>(),
    transaction: vi.fn<PrismaTransaction>(async (operation) => operation(transactionClient)),
    transactionClient,
    userFindMany: vi.fn<UserFindMany>()
  };
});

vi.mock("./db", () => ({
  prisma: {
    $transaction: prismaMocks.transaction,
    user: { findMany: prismaMocks.userFindMany },
    userSanction: { findMany: prismaMocks.sanctionFindMany }
  }
}));

import { prismaMaintenanceCleanupStore } from "./prisma-maintenance-store";

describe("prisma maintenance user mutation serialization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMocks.rawCalls.length = 0;
    prismaMocks.userFindMany.mockResolvedValue([{ id: "user-b" }, { id: "user-a" }]);
    prismaMocks.sanctionFindMany.mockResolvedValue([
      { userId: "user-b" },
      { userId: "user-a" },
      { userId: "user-a" }
    ]);
    prismaMocks.transaction.mockImplementation(async (operation) => operation(prismaMocks.transactionClient));
    prismaMocks.transactionClient.user.updateMany.mockResolvedValue({ count: 2 });
    prismaMocks.transactionClient.userSanction.updateMany.mockResolvedValue({ count: 3 });
  });

  it("locks sorted users before releasing expired restrictions", async () => {
    const now = new Date("2026-06-16T04:30:00.000Z");

    await expect(prismaMaintenanceCleanupStore.releaseExpiredRestrictions(now)).resolves.toBe(2);

    expect(prismaMocks.userFindMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
      select: { id: true },
      take: 100,
      where: { bookingStatus: "RESTRICTED", restrictedUntil: { lte: now } }
    });
    expect(prismaMocks.transactionClient.user.updateMany).toHaveBeenCalledWith({
      data: { bookingStatus: "ACTIVE", restrictedUntil: null, restrictionReason: null },
      where: {
        bookingStatus: "RESTRICTED",
        id: { in: ["user-b", "user-a"] },
        restrictedUntil: { lte: now }
      }
    });
    expect(lockValues()).toEqual([["user:user-a"], ["user:user-b"]]);
  });

  it("deduplicates and locks users before revoking expired sanctions", async () => {
    const now = new Date("2026-06-16T04:30:00.000Z");

    await expect(prismaMaintenanceCleanupStore.revokeExpiredSanctions(now)).resolves.toBe(3);

    expect(prismaMocks.sanctionFindMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
      select: { userId: true },
      take: 100,
      where: { endsAt: { lte: now }, status: "ACTIVE" }
    });
    expect(prismaMocks.transactionClient.userSanction.updateMany).toHaveBeenCalledWith({
      data: { revokedAt: now, revokedById: null, revokedReason: "기간 만료", status: "REVOKED" },
      where: {
        endsAt: { lte: now },
        status: "ACTIVE",
        userId: { in: ["user-b", "user-a", "user-a"] }
      }
    });
    expect(lockValues()).toEqual([["user:user-a"], ["user:user-b"]]);
  });
});

function lockValues(): readonly (readonly unknown[])[] {
  return prismaMocks.rawCalls
    .filter((call) => call.strings.join("?").includes("pg_advisory_xact_lock"))
    .map((call) => call.values);
}
