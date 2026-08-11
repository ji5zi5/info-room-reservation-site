import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { mintCsrfToken, validateCsrfToken } from "@/lib/csrf";
import { prismaCsrfTokenStore } from "@/lib/prisma-csrf-store";
import { prismaRetentionStore } from "@/lib/prisma-retention-store";
import { EMPTY_RETENTION_COUNTS, RETENTION_EXPIRED_TEXT } from "@/lib/retention-policy";

import {
  prisma,
  resetPostgresTestDatabase,
  seedUser,
  withAdminDatabaseContext,
  withStudentDatabaseContext,
  withSystemDatabaseContext
} from "./postgres-test-db";

beforeEach(async () => {
  await resetPostgresTestDatabase();
});

afterAll(async () => {
  await resetPostgresTestDatabase();
  await prisma.$disconnect();
});

describe("real PostgreSQL operational stores", () => {
  it("keeps at most four valid CSRF tokens under concurrent issuance", async () => {
    const [user, otherUser] = await Promise.all([
      seedUser({ id: "csrf-user" }),
      seedUser({ id: "csrf-other-user" })
    ]);
    const { otherReservation, session } = await withSystemDatabaseContext(async (transaction) => {
      const createdSession = await transaction.session.create({
        data: {
          expiresAt: new Date("2030-06-10T12:00:00.000Z"),
          tokenHash: "integration-session-token",
          userId: user.id
        }
      });
      await transaction.reservation.create({
        data: {
          date: "2030-06-11",
          reason: "내 예약",
          status: "CONFIRMED",
          studyPeriod: "EIGHTH",
          userId: user.id
        }
      });
      const createdOtherReservation = await transaction.reservation.create({
        data: {
          date: "2030-06-11",
          reason: "다른 학생 예약",
          status: "CONFIRMED",
          studyPeriod: "EIGHTH",
          userId: otherUser.id
        }
      });
      return { otherReservation: createdOtherReservation, session: createdSession };
    });
    const now = new Date("2030-06-10T03:00:00.000Z");

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () =>
        mintCsrfToken({ now, sessionId: session.id, store: prismaCsrfTokenStore })
      )
    );

    await expect(
      withSystemDatabaseContext((transaction) => transaction.csrfToken.count({ where: { sessionId: session.id } }))
    ).resolves.toBe(4);
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

    const studentView = await withStudentDatabaseContext(user.id, async (transaction) => ({
      csrfTokenCount: await transaction.csrfToken.count(),
      reservations: await transaction.reservation.findMany({ select: { userId: true } }),
      role: await transaction.$queryRaw<readonly { readonly bypassRls: boolean; readonly currentUser: string }[]>`
        SELECT current_user AS "currentUser", rolbypassrls AS "bypassRls"
        FROM pg_roles
        WHERE rolname = current_user
      `,
      sessionCount: await transaction.session.count(),
      users: await transaction.user.findMany({ select: { id: true } })
    }));

    expect(studentView.role).toEqual([{ bypassRls: false, currentUser: "info_room_runtime" }]);
    expect(studentView.users).toEqual([{ id: user.id }]);
    expect(studentView.reservations).toEqual([{ userId: user.id }]);
    expect(studentView.sessionCount).toBe(0);
    expect(studentView.csrfTokenCount).toBe(0);
    await expect(
      withStudentDatabaseContext(user.id, (transaction) =>
        transaction.reservation.updateMany({
          data: { reason: "학생 A가 변경 시도" },
          where: { id: otherReservation.id }
        })
      )
    ).resolves.toMatchObject({ count: 0 });
    await expect(
      withStudentDatabaseContext(user.id, (transaction) =>
        transaction.$executeRaw`
          INSERT INTO "Reservation" ("id", "date", "studyPeriod", "status", "reason", "userId", "updatedAt")
          VALUES (
            ${"student-a-cross-user-insert"},
            ${"2030-06-12"},
            ${"EIGHTH"},
            ${"CONFIRMED"},
            ${"학생 A가 대리 생성 시도"},
            ${otherUser.id},
            ${new Date("2030-06-10T03:00:00.000Z")}
          )
        `
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2010" &&
        error.meta?.code === "42501" &&
        typeof error.meta.message === "string" &&
        error.meta.message.includes('new row violates row-level security policy for table "Reservation"')
    );
    await expect(
      withSystemDatabaseContext((transaction) =>
        transaction.reservation.findUniqueOrThrow({ where: { id: otherReservation.id } })
      )
    ).resolves.toMatchObject({ reason: "다른 학생 예약" });
    await expect(
      withSystemDatabaseContext((transaction) =>
        transaction.reservation.count({ where: { date: "2030-06-12", userId: otherUser.id } })
      )
    ).resolves.toBe(0);
  });

  it("grants a notification delivery claim to exactly one contender", async () => {
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => claimNotificationDeliveryAsSystem())
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(
      withSystemDatabaseContext((transaction) => transaction.notificationDelivery.count())
    ).resolves.toBe(1);
    await expect(
      withSystemDatabaseContext((transaction) => transaction.notificationDelivery.findFirstOrThrow())
    ).resolves.toMatchObject({ attempts: 1, status: "SENDING" });
  });

  it("applies each approved retention transformation once and remains idempotent", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1_000);
    const [admin, departed] = await Promise.all([
      seedUser({ id: "retention-admin", role: "ADMIN" }),
      withSystemDatabaseContext((transaction) =>
        transaction.user.create({
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
      )
    ]);
    const { action, audit, reservation, sanction } = await withSystemDatabaseContext(async (transaction) => {
      await transaction.session.create({
        data: {
          expiresAt: new Date("2031-01-01T00:00:00.000Z"),
          tokenHash: "retention-session",
          userId: departed.id
        }
      });
      const createdReservation = await transaction.reservation.create({
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
      const createdAction = await transaction.adminAction.create({
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
      const createdSanction = await transaction.userSanction.create({
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
      const createdAudit = await transaction.auditLog.create({
        data: {
          action: "OLD_AUDIT",
          actorId: admin.id,
          createdAt: old,
          detail: "오래된 감사 상세",
          userId: departed.id
        }
      });
      await transaction.retentionPolicy.create({
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
      return {
        action: createdAction,
        audit: createdAudit,
        reservation: createdReservation,
        sanction: createdSanction
      };
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

    const retained = await withAdminDatabaseContext(admin.id, async (transaction) => ({
      action: await transaction.adminAction.findUniqueOrThrow({ where: { id: action.id } }),
      audit: await transaction.auditLog.findUniqueOrThrow({ where: { id: audit.id } }),
      departed: await transaction.user.findUniqueOrThrow({ where: { id: departed.id } }),
      reservation: await transaction.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      sanction: await transaction.userSanction.findUniqueOrThrow({ where: { id: sanction.id } }),
      sessionCount: await transaction.session.count({ where: { userId: departed.id } })
    }));
    expect(retained.reservation).toMatchObject({ reason: null });
    expect(retained.action).toMatchObject({
      after: null,
      before: null,
      ipHash: null,
      reason: null
    });
    expect(retained.sanction).toMatchObject({
      reason: RETENTION_EXPIRED_TEXT,
      revokedReason: null
    });
    expect(retained.audit).toMatchObject({ detail: RETENTION_EXPIRED_TEXT });
    expect(retained.sessionCount).toBe(0);
    expect(retained.departed).toMatchObject({
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

async function claimNotificationDeliveryAsSystem(): Promise<boolean> {
  return withSystemDatabaseContext(async (transaction) => {
    try {
      await transaction.notificationDelivery.create({
        data: {
          attempts: 1,
          date: "2030-06-11",
          kind: "CLOSED_LIST",
          messageIds: "[]",
          status: "SENDING",
          studyPeriod: "EIGHTH"
        }
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false;
      }
      throw error;
    }
  });
}
