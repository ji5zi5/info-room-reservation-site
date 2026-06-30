import { beforeEach, describe, expect, it, vi } from "vitest";

type UpdateManyInput = {
  readonly data: unknown;
  readonly where: unknown;
};

type RawCall = {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
};

type FakePrismaTransaction = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly userSanction: {
    readonly updateMany: (input: UpdateManyInput) => Promise<{ readonly count: number }>;
  };
};

type TransactionOperation = (transaction: FakePrismaTransaction) => Promise<unknown>;

const prismaMocks = vi.hoisted(() => {
  const rawCalls: RawCall[] = [];
  const userSanctionUpdateMany = vi.fn(async (_input: UpdateManyInput): Promise<{ readonly count: number }> => ({
    count: 3
  }));
  const transactionObject: FakePrismaTransaction = {
    async $executeRaw(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<number> {
      rawCalls.push({ strings: [...strings], values });
      return 1;
    },
    userSanction: {
      updateMany: userSanctionUpdateMany
    }
  };
  return {
    rawCalls,
    transaction: vi.fn(async (operation: TransactionOperation): Promise<unknown> => operation(transactionObject)),
    userSanctionUpdateMany
  };
});

vi.mock("./db", () => ({
  prisma: {
    $transaction: prismaMocks.transaction,
    userSanction: {
      updateMany: prismaMocks.userSanctionUpdateMany
    }
  }
}));

import { prismaMaintenanceCleanupStore } from "./prisma-maintenance-store";

beforeEach(() => {
  prismaMocks.rawCalls.length = 0;
  prismaMocks.transaction.mockClear();
  prismaMocks.userSanctionUpdateMany.mockClear();
});

describe("Prisma maintenance cleanup store", () => {
  it("revokes expired active temporary sanctions", async () => {
    const now = new Date("2026-06-14T12:00:00.000Z");

    await expect(prismaMaintenanceCleanupStore.revokeExpiredSanctions(now)).resolves.toBe(3);

    expect(prismaMocks.rawCalls).toEqual([
      { strings: ["select set_config(", ", ", ", true)"], values: ["app.current_user_id", ""] },
      { strings: ["select set_config(", ", ", ", true)"], values: ["app.current_user_role", "SYSTEM"] }
    ]);
    expect(prismaMocks.userSanctionUpdateMany).toHaveBeenCalledWith({
      data: {
        revokedAt: now,
        revokedById: null,
        revokedReason: "기간 만료",
        status: "REVOKED"
      },
      where: {
        endsAt: { lte: now },
        status: "ACTIVE"
      }
    });
  });
});
