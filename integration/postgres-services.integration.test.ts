import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { mintCsrfToken, validateCsrfToken } from "@/lib/csrf";
import { prismaCsrfTokenStore } from "@/lib/prisma-csrf-store";
import { prismaClosedPeriodNotificationRepository } from "@/lib/prisma-notification-repository";
import { prismaRetentionStore } from "@/lib/prisma-retention-store";
import { EMPTY_RETENTION_COUNTS, RETENTION_EXPIRED_TEXT } from "@/lib/retention-policy";

import { prisma, resetPostgresTestDatabase, seedUser } from "./postgres-test-db";

beforeEach(async () => {
  await resetPostgresTestDatabase();
});

afterAll(async () => {
  await resetPostgresTestDatabase();
  await prisma.$disconnect();
});

describe("real PostgreSQL operational stores", () => {
  it("keeps at most four valid CSRF tokens under concurrent issuance", async () => {
    const user = await seedUser({ id: "csrf-user" });
    const session = await prisma.session.create({
      data: {
        expiresAt: new Date("2030-06-10T12:00:00.000Z"),
        tokenHash: "integration-session-token",
        userId: user.id
      }
    });
    const now = new Date("2030-06-10T03:00:00.000Z");

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () =>
        mintCsrfToken({ now, sessionId: session.id, store: prismaCsrfTokenStore })
      )
    );

    await expect(prisma.csrfToken.count({ where: { sessionId: session.id } })).resolves.toBe(4);
    const validations = await Promise.all(
      tokens.map((token) =>
        validateCsrfToken({
          now: new Date(now.getTime() + 1_000),
          sessionId: session.id,
          store: prismaCsrfTokenStore,
          token
        })
      )
    );
    expect(validations.filter((result) => result.kind === "ok")).toHaveLength(4);
  });

  it("grants a notification delivery claim to exactly one contender", async () => {
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        prismaClosedPeriodNotificationRepository.claimDelivery({
          date: "2030-06-11",
          staleSendingBefore: new Date("2030-06-11T07:15:00.000Z"),
          studyPeriod: "EIGHTH"
        })
      )
    );

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(prisma.notificationDelivery.count()).resolves.toBe(1);
    await expect(prisma.notificationDelivery.findFirstOrThrow()).resolves.toMatchObject({
      attempts: 1,
      status: "SENDING"
    });
  });

  it("applies each approved retention transformation once and remains idempotent", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1_000);
    const [admin, departed] = await Promise.all([
      seedUser({ id: "retention-admin", role: "ADMIN" }),
      prisma.user.create({
        data: {
          bookingStatus: "ACTIVE",
          departedAt: old,
          generation: 32,
          id: "retention-departed",
          name: "탈퇴 예정",
          riroId: "riro-retention-departed",
          role: "STUDENT",
          studentNumber: "test-retention-departed"
        }
      })
    ]);
    await prisma.session.create({
      data: {
        expiresAt: new Date("2031-01-01T00:00:00.000Z"),
        tokenHash: "retention-session",
        userId: departed.id
      }
    });
    const reservation = await prisma.reservation.create({
      data: {
        createdAt: old,
        date: "2029-01-02",
        reason: "오래된 예약 사유",
        status: "CANCELLED",
        studyPeriod: "EIGHTH",
        updatedAt: old,
        userId: departed.id
      }
    });
    const action = await prisma.adminAction.create({
      data: {
        action: "OLD_ACTION",
        actorId: admin.id,
        after: "{\"status\":\"after\"}",
        before: "{\"status\":\"before\"}",
        createdAt: old,
        ipHash: "old-ip-hash",
        reason: "오래된 관리자 사유",
        targetUserId: departed.id
      }
    });
    const sanction = await prisma.userSanction.create({
      data: {
        actorId: admin.id,
        createdAt: old,
        reason: "오래된 제재 사유",
        revokedAt: old,
        revokedById: admin.id,
        revokedReason: "오래된 해제 사유",
        status: "REVOKED",
        type: "ADMIN_RESTRICTION",
        userId: departed.id
      }
    });
    const audit = await prisma.auditLog.create({
      data: {
        action: "OLD_AUDIT",
        actorId: admin.id,
        createdAt: old,
        detail: "오래된 감사 상세",
        userId: departed.id
      }
    });
    await prisma.retentionPolicy.create({
      data: {
        adminDetailDays: 30,
        approvedAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
        approvedBy: "privacy-officer",
        auditDetailDays: 30,
        departedUserIdentityDays: 30,
        enabled: false,
        id: "global",
        policyVersion: "integration-v1",
        reservationReasonDays: 30,
        sanctionReasonDays: 30
      }
    });
    const actor = { id: admin.id, role: "ADMIN" } as const;
    const { preview } = await prismaRetentionStore.preview({ actor, now });

    expect(preview.counts).toEqual({
      adminActionDetails: 1,
      auditDetails: 1,
      departedUserIdentities: 1,
      reservationReasons: 1,
      sanctionReasons: 1
    });
    await expect(
      prismaRetentionStore.applyApproved({
        actor,
        expectedChecksum: preview.checksum,
        ipHash: "integration-ip",
        now,
        purgeEnabled: true
      })
    ).resolves.toMatchObject({ kind: "applied", preview: { counts: preview.counts } });

    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({
      reason: null
    });
    await expect(prisma.adminAction.findUniqueOrThrow({ where: { id: action.id } })).resolves.toMatchObject({
      after: null,
      before: null,
      ipHash: null,
      reason: null
    });
    await expect(prisma.userSanction.findUniqueOrThrow({ where: { id: sanction.id } })).resolves.toMatchObject({
      reason: RETENTION_EXPIRED_TEXT,
      revokedReason: null
    });
    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).resolves.toMatchObject({
      detail: RETENTION_EXPIRED_TEXT
    });
    await expect(prisma.session.count({ where: { userId: departed.id } })).resolves.toBe(0);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: departed.id } })).resolves.toMatchObject({
      anonymizedAt: now,
      bookingStatus: "BANNED",
      generation: 0,
      name: "탈퇴 사용자",
      riroId: null
    });
    await expect(
      prismaRetentionStore.applyScheduled({ now: new Date(now.getTime() + 1_000), purgeEnabled: true })
    ).resolves.toMatchObject({ counts: EMPTY_RETENTION_COUNTS, kind: "applied" });
  });
});
