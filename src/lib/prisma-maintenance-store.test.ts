import { beforeEach, describe, expect, it, vi } from "vitest";

type UpdateManyInput = {
  readonly data: unknown;
  readonly where: unknown;
};

const prismaMocks = vi.hoisted(() => ({
  userSanctionUpdateMany: vi.fn(async (_input: UpdateManyInput): Promise<{ readonly count: number }> => ({ count: 3 }))
}));

vi.mock("./db", () => ({
  prisma: {
    userSanction: {
      updateMany: prismaMocks.userSanctionUpdateMany
    }
  }
}));

import { prismaMaintenanceCleanupStore } from "./prisma-maintenance-store";

beforeEach(() => {
  prismaMocks.userSanctionUpdateMany.mockClear();
});

describe("Prisma maintenance cleanup store", () => {
  it("revokes expired active temporary sanctions", async () => {
    const now = new Date("2026-06-14T12:00:00.000Z");

    await expect(prismaMaintenanceCleanupStore.revokeExpiredSanctions(now)).resolves.toBe(3);

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
