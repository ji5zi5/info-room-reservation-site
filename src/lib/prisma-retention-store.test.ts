import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RETENTION_EXPIRED_TEXT, type RetentionPolicy } from "./retention-policy";

type FindMany = (input: unknown) => Promise<readonly { readonly id: string }[]>;
type WriteMany = (input: unknown) => Promise<{ readonly count: number }>;
type WriteOne = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: WriteOne; readonly findMany: FindMany; readonly updateMany: WriteMany };
  readonly auditLog: { readonly create: WriteOne; readonly findMany: FindMany; readonly updateMany: WriteMany };
  readonly reservation: { readonly findMany: FindMany; readonly updateMany: WriteMany };
  readonly retentionPolicy: {
    readonly findUnique: (input: unknown) => Promise<RetentionPolicy | null>;
    readonly update: WriteOne;
    readonly upsert: WriteOne;
  };
  readonly session: { readonly deleteMany: WriteMany };
  readonly user: { readonly findMany: FindMany; readonly updateMany: WriteMany };
  readonly userSanction: { readonly findMany: FindMany; readonly updateMany: WriteMany };
};
type PrismaTransaction = <T>(
  operation: (transaction: TransactionClient) => Promise<T>,
  options?: unknown
) => Promise<T>;

const db = vi.hoisted(() => {
  const client = {
    $executeRaw: vi.fn(async () => 1),
    adminAction: {
      create: vi.fn<WriteOne>(async () => ({ id: "cleanup-action" })),
      findMany: vi.fn<FindMany>(),
      updateMany: vi.fn<WriteMany>(async () => ({ count: 2 }))
    },
    auditLog: {
      create: vi.fn<WriteOne>(async () => ({ id: "cleanup-audit" })),
      findMany: vi.fn<FindMany>(),
      updateMany: vi.fn<WriteMany>(async () => ({ count: 1 }))
    },
    reservation: {
      findMany: vi.fn<FindMany>(),
      updateMany: vi.fn<WriteMany>(async () => ({ count: 1 }))
    },
    retentionPolicy: {
      findUnique: vi.fn<(input: unknown) => Promise<RetentionPolicy | null>>(),
      update: vi.fn<WriteOne>(async () => ({ id: "global" })),
      upsert: vi.fn<WriteOne>(async () => approvedPolicy())
    },
    session: { deleteMany: vi.fn<WriteMany>(async () => ({ count: 1 })) },
    user: {
      findMany: vi.fn<FindMany>(),
      updateMany: vi.fn<WriteMany>(async () => ({ count: 1 }))
    },
    userSanction: {
      findMany: vi.fn<FindMany>(),
      updateMany: vi.fn<WriteMany>(async () => ({ count: 1 }))
    }
  } satisfies TransactionClient;

  return {
    client,
    transaction: vi.fn<PrismaTransaction>(async (operation) => operation(client))
  };
});

vi.mock("./db", () => ({
  prisma: { $transaction: db.transaction }
}));

import { prismaRetentionStore } from "./prisma-retention-store";

const actor = { id: "admin-1", role: "ADMIN" } as const;
const now = new Date("2026-07-24T12:00:00.000Z");

describe("Prisma retention store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.client.retentionPolicy.findUnique.mockResolvedValue(approvedPolicy());
    db.client.reservation.findMany.mockResolvedValue([{ id: "reservation-a" }]);
    db.client.adminAction.findMany.mockResolvedValue([{ id: "action-b" }, { id: "action-a" }]);
    db.client.userSanction.findMany.mockResolvedValue([{ id: "sanction-a" }]);
    db.client.auditLog.findMany.mockResolvedValue([{ id: "audit-a" }]);
    db.client.user.findMany.mockResolvedValue([{ id: "user-a" }]);
    db.transaction.mockImplementation(async (operation) => operation(db.client));
  });

  it("does not open a database transaction when the deployment purge gate is disabled", async () => {
    await expect(
      prismaRetentionStore.applyScheduled({ now, purgeEnabled: false })
    ).resolves.toMatchObject({ kind: "disabled" });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("previews at most 100 sorted candidates per approved horizon", async () => {
    const result = await prismaRetentionStore.preview({ actor, now });

    expect(result.preview.counts).toEqual({
      adminActionDetails: 2,
      auditDetails: 1,
      departedUserIdentities: 1,
      reservationReasons: 1,
      sanctionReasons: 1
    });
    expect(result.preview.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(db.client.reservation.findMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
      select: { id: true },
      take: 100,
      where: {
        reason: { not: null },
        updatedAt: { lte: cutoff(90) }
      }
    });
    for (const findMany of candidateReaders()) {
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
        orderBy: { id: "asc" },
        select: { id: true },
        take: 100
      }));
    }
  });

  it("rejects a stale checksum without any destructive write", async () => {
    await expect(
      prismaRetentionStore.applyApproved({
        actor,
        expectedChecksum: "stale",
        ipHash: "ip-hash",
        now,
        purgeEnabled: true
      })
    ).resolves.toMatchObject({ kind: "stale" });

    expectDestructiveWrites(0);
    expect(db.client.retentionPolicy.update).not.toHaveBeenCalled();
  });

  it("scrubs only the approved field matrix and records aggregate counts", async () => {
    const { preview } = await prismaRetentionStore.preview({ actor, now });
    vi.clearAllMocks();
    restoreCandidateMocks();

    const result = await prismaRetentionStore.applyApproved({
      actor,
      expectedChecksum: preview.checksum,
      ipHash: "ip-hash",
      now,
      purgeEnabled: true
    });

    expect(result).toMatchObject({ kind: "applied", preview: { counts: preview.counts } });
    expect(db.client.reservation.updateMany).toHaveBeenCalledWith({
      data: { reason: null },
      where: { id: { in: ["reservation-a"] }, reason: { not: null } }
    });
    expect(db.client.adminAction.updateMany).toHaveBeenCalledWith({
      data: { after: null, before: null, ipHash: null, reason: null },
      where: { id: { in: ["action-a", "action-b"] } }
    });
    expect(db.client.userSanction.updateMany).toHaveBeenCalledWith({
      data: { reason: RETENTION_EXPIRED_TEXT, revokedReason: null },
      where: { id: { in: ["sanction-a"] }, status: { not: "ACTIVE" } }
    });
    expect(db.client.auditLog.updateMany).toHaveBeenCalledWith({
      data: { detail: RETENTION_EXPIRED_TEXT },
      where: { id: { in: ["audit-a"] } }
    });
    expect(db.client.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-a" } });
    expect(db.client.user.updateMany).toHaveBeenCalledWith({
      data: {
        anonymizedAt: now,
        bookingStatus: "BANNED",
        generation: 0,
        name: "탈퇴 사용자",
        restrictedUntil: null,
        restrictionReason: null,
        riroId: null,
        shadowBanProfile: "NORMAL",
        studentNumber: expect.stringMatching(/^ANON-[0-9a-f-]{36}$/u)
      },
      where: {
        anonymizedAt: null,
        departedAt: { lte: cutoff(30) },
        id: "user-a"
      }
    });
    expect(db.client.retentionPolicy.update).toHaveBeenCalledWith({
      data: { enabled: true },
      where: { id: "global" }
    });
    const auditWrite = db.client.auditLog.create.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(auditWrite)).not.toContain("reservation-a");
    expect(JSON.stringify(auditWrite)).not.toContain("user-a");
    const parsedAuditWrite = z.object({
      data: z.object({ detail: z.string() })
    }).parse(auditWrite);
    expect(JSON.parse(parsedAuditWrite.data.detail)).toMatchObject({
      counts: { reservationReasons: 1 }
    });
  });

  it("does not revoke sessions when the departure marker no longer qualifies", async () => {
    const { preview } = await prismaRetentionStore.preview({ actor, now });
    vi.clearAllMocks();
    restoreCandidateMocks();
    db.client.user.updateMany.mockResolvedValue({ count: 0 });

    const result = await prismaRetentionStore.applyApproved({
      actor,
      expectedChecksum: preview.checksum,
      ipHash: "ip-hash",
      now,
      purgeEnabled: true
    });

    expect(result).toMatchObject({
      kind: "applied",
      preview: { counts: { departedUserIdentities: 0 } }
    });
    expect(db.client.session.deleteMany).not.toHaveBeenCalled();
  });

  it("saves policy changes disabled and audits the policy version", async () => {
    db.client.retentionPolicy.upsert.mockResolvedValue({
      ...approvedPolicy(),
      enabled: false,
      policyVersion: "school-policy-v2"
    });

    const result = await prismaRetentionStore.save({
      actor,
      ipHash: "ip-hash",
      policy: {
        ...approvedPolicy(),
        approvedAt: new Date("2026-07-20T00:00:00.000Z"),
        policyVersion: "school-policy-v2"
      }
    });

    expect(result).toMatchObject({ enabled: false, policyVersion: "school-policy-v2" });
    expect(db.client.retentionPolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ enabled: false, id: "global", policyVersion: "school-policy-v2" }),
      update: expect.objectContaining({ enabled: false, policyVersion: "school-policy-v2" }),
      where: { id: "global" }
    }));
    expect(JSON.stringify(db.client.adminAction.create.mock.calls.at(-1)?.[0])).toContain(
      "RETENTION_POLICY_PATCH"
    );
  });

  it("revokes an enabled policy without deleting historical data", async () => {
    db.client.retentionPolicy.findUnique.mockResolvedValue({ ...approvedPolicy(), enabled: true });
    db.client.retentionPolicy.update.mockResolvedValue({ ...approvedPolicy(), enabled: false });

    await expect(
      prismaRetentionStore.disable({ actor, ipHash: "ip-hash" })
    ).resolves.toMatchObject({ enabled: false });

    expect(db.client.retentionPolicy.update).toHaveBeenCalledWith({
      data: { enabled: false },
      where: { id: "global" }
    });
    expectDestructiveWrites(0);
  });
});

function approvedPolicy(): RetentionPolicy {
  return {
    adminDetailDays: 365,
    approvedAt: new Date("2026-07-01T00:00:00.000Z"),
    approvedBy: "school-privacy-officer",
    auditDetailDays: 365,
    departedUserIdentityDays: 30,
    enabled: false,
    id: "global",
    policyVersion: "school-policy-v1",
    reservationReasonDays: 90,
    sanctionReasonDays: 365
  };
}

function cutoff(days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function candidateReaders(): readonly FindMany[] {
  return [
    db.client.adminAction.findMany,
    db.client.auditLog.findMany,
    db.client.reservation.findMany,
    db.client.user.findMany,
    db.client.userSanction.findMany
  ];
}

function expectDestructiveWrites(count: number): void {
  for (const write of destructiveWrites()) {
    expect(write).toHaveBeenCalledTimes(count);
  }
}

function destructiveWrites(): readonly WriteMany[] {
  return [
    db.client.adminAction.updateMany,
    db.client.auditLog.updateMany,
    db.client.reservation.updateMany,
    db.client.session.deleteMany,
    db.client.user.updateMany,
    db.client.userSanction.updateMany
  ];
}

function restoreCandidateMocks(): void {
  db.client.retentionPolicy.findUnique.mockResolvedValue(approvedPolicy());
  db.client.reservation.findMany.mockResolvedValue([{ id: "reservation-a" }]);
  db.client.adminAction.findMany.mockResolvedValue([{ id: "action-b" }, { id: "action-a" }]);
  db.client.userSanction.findMany.mockResolvedValue([{ id: "sanction-a" }]);
  db.client.auditLog.findMany.mockResolvedValue([{ id: "audit-a" }]);
  db.client.user.findMany.mockResolvedValue([{ id: "user-a" }]);
  db.client.adminAction.create.mockResolvedValue({ id: "cleanup-action" });
  db.client.auditLog.create.mockResolvedValue({ id: "cleanup-audit" });
  db.client.reservation.updateMany.mockResolvedValue({ count: 1 });
  db.client.adminAction.updateMany.mockResolvedValue({ count: 2 });
  db.client.userSanction.updateMany.mockResolvedValue({ count: 1 });
  db.client.auditLog.updateMany.mockResolvedValue({ count: 1 });
  db.client.session.deleteMany.mockResolvedValue({ count: 1 });
  db.client.user.updateMany.mockResolvedValue({ count: 1 });
  db.client.retentionPolicy.update.mockResolvedValue({ id: "global" });
  db.client.retentionPolicy.upsert.mockResolvedValue(approvedPolicy());
  db.transaction.mockImplementation(async (operation) => operation(db.client));
}
