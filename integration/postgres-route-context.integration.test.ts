import type { User } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CurrentSession, SessionUser } from "@/lib/session";
import { StudentPeriodSummarySchema } from "@/lib/student-period-summary";

// allow: SIZE_OK — one PostgreSQL actor-context integration suite with shared protected fixtures.

type RouteAuthState = {
  adminSession: CurrentSession | null;
  studentUser: SessionUser | null;
};

const routeAuth = vi.hoisted<RouteAuthState>(() => ({
  adminSession: null,
  studentUser: null
}));
const TEST_NOW = vi.hoisted(() => new Date("2026-08-10T03:00:00.000Z"));

vi.mock("@/lib/session", () => {
  class UnauthorizedSessionError extends Error {}
  class ForbiddenSessionError extends Error {}

  return {
    ForbiddenSessionError,
    requireAdmin: vi.fn(async () => {
      if (routeAuth.adminSession === null) {
        throw new UnauthorizedSessionError("관리자 로그인이 필요합니다.");
      }
      return routeAuth.adminSession.user;
    }),
    requireAdminSession: vi.fn(async () => {
      if (routeAuth.adminSession === null) {
        throw new UnauthorizedSessionError("관리자 로그인이 필요합니다.");
      }
      return routeAuth.adminSession;
    }),
    requireSession: vi.fn(async () => {
      if (routeAuth.studentUser === null) {
        throw new UnauthorizedSessionError("로그인이 필요합니다.");
      }
      return { id: "integration-student-session", user: routeAuth.studentUser };
    }),
    requireUser: vi.fn(async () => {
      if (routeAuth.studentUser === null) {
        throw new UnauthorizedSessionError("로그인이 필요합니다.");
      }
      return routeAuth.studentUser;
    }),
    UnauthorizedSessionError
  };
});

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => reason,
  validateRequestCsrf: vi.fn(async () => ({ kind: "ok" }))
}));

vi.mock("@/lib/request-security", () => ({
  requireMutatingRequestSafety: vi.fn(() => null)
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceAdminMutationRateLimit: vi.fn(async () => ({
    kind: "allowed",
    remaining: 99,
    resetAt: new Date(TEST_NOW.getTime() + 60_000)
  })),
  enforceReservationRateLimit: vi.fn(async () => ({
    kind: "allowed",
    remaining: 99,
    resetAt: new Date(TEST_NOW.getTime() + 60_000)
  }))
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: vi.fn(() => false)
}));

import { GET as getAdminActions } from "@/app/api/admin/actions/route";
import { GET as getAdminDashboard } from "@/app/api/admin/dashboard/route";
import { GET as getAdminPeriodSettings, PATCH as patchAdminPeriodSettings } from "@/app/api/admin/period-settings/route";
import { GET as getAdminReservations, POST as createAdminReservation } from "@/app/api/admin/reservations/route";
import { GET as getAdminStatistics } from "@/app/api/admin/statistics/route";
import { GET as getAdminUser } from "@/app/api/admin/users/[id]/route";
import { POST as revokeAdminUserSessions } from "@/app/api/admin/users/[id]/sessions/revoke/route";
import { GET as getAdminUsers } from "@/app/api/admin/users/route";
import { GET as getStudentProfile } from "@/app/api/me/profile/route";
import { GET as getStudentPeriods } from "@/app/api/periods/route";
import { DELETE as cancelStudentReservation } from "@/app/api/reservations/[id]/route";
import { prismaMaintenanceCleanupStore } from "@/lib/prisma-maintenance-store";
import { prismaClosedPeriodNotificationRepository } from "@/lib/prisma-notification-repository";
import { prismaOperationalJobStore } from "@/lib/prisma-operational-job-store";
import { getPrismaReadinessReport } from "@/lib/prisma-readiness";

import {
  prisma,
  resetPostgresTestDatabase,
  seedUser,
  withAdminDatabaseContext,
  withStudentDatabaseContext,
  withSystemDatabaseContext
} from "./postgres-test-db";

const TEST_DATE = "2026-08-11";
const CLOSED_DATE = "2026-08-09";
const StudentPeriodsPayloadSchema = z.object({ periods: z.array(StudentPeriodSummarySchema) }).strict();
const StoredJsonObjectSchema = z.record(z.string(), z.unknown());

type TestFixtures = {
  readonly admin: User;
  readonly ownReservationId: string;
  readonly peer: User;
  readonly peerReservationId: string;
  readonly student: User;
};

let fixtures: TestFixtures | null = null;
let runtimePrerequisiteSatisfied = false;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
  runtimePrerequisiteSatisfied = false;
  await assertRestrictedRuntimePrerequisite();
  runtimePrerequisiteSatisfied = true;
  await resetPostgresTestDatabase();
  fixtures = await seedProtectedFixtures();
  routeAuth.adminSession = sessionFor(fixtures.admin, "integration-admin-session");
  routeAuth.studentUser = sessionUserFor(fixtures.student);
});

afterAll(async () => {
  if (runtimePrerequisiteSatisfied) {
    await resetPostgresTestDatabase();
  }
  await prisma.$disconnect();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("real PostgreSQL production route and store actor context", () => {
  it("persists one complete restriction trail Given an owned reservation When the student repeats cancellation Then both responses are idempotent", async () => {
    // Given
    const seeded = requireFixtures();

    // When
    const firstResponse = await cancelStudentReservation(
      deleteRequest(`/api/reservations/${seeded.ownReservationId}`),
      routeContext(seeded.ownReservationId)
    );
    const repeatedResponse = await cancelStudentReservation(
      deleteRequest(`/api/reservations/${seeded.ownReservationId}`),
      routeContext(seeded.ownReservationId)
    );
    const crossUserResponse = await cancelStudentReservation(
      deleteRequest(`/api/reservations/${seeded.peerReservationId}`),
      routeContext(seeded.peerReservationId)
    );

    // Then
    expect([firstResponse.status, repeatedResponse.status]).toEqual([200, 200]);
    expect(crossUserResponse.status).toBe(403);
    const persisted = await withAdminDatabaseContext(seeded.admin.id, async (transaction) => ({
      actions: await transaction.adminAction.findMany({
        where: { action: "STUDENT_RESERVATION_CANCEL_RESTRICTION", reservationId: seeded.ownReservationId }
      }),
      audits: await transaction.auditLog.findMany({
        where: { action: "STUDENT_RESERVATION_CANCEL_RESTRICTION", userId: seeded.student.id }
      }),
      peerActions: await transaction.adminAction.findMany({
        where: { action: "STUDENT_RESERVATION_CANCEL_RESTRICTION", reservationId: seeded.peerReservationId }
      }),
      peerAudits: await transaction.auditLog.findMany({
        where: { action: "STUDENT_RESERVATION_CANCEL_RESTRICTION", userId: seeded.peer.id }
      }),
      peerReservation: await transaction.reservation.findUnique({ where: { id: seeded.peerReservationId } }),
      peerSanctions: await transaction.userSanction.findMany({
        where: { type: "CANCELLATION_RESTRICTION", userId: seeded.peer.id }
      }),
      reservation: await transaction.reservation.findUnique({ where: { id: seeded.ownReservationId } }),
      sanctions: await transaction.userSanction.findMany({
        where: { type: "CANCELLATION_RESTRICTION", userId: seeded.student.id }
      }),
      user: await transaction.user.findUnique({ where: { id: seeded.student.id } })
    }));
    expect(persisted.reservation?.status).toBe("CANCELLED");
    expect(persisted.user).toMatchObject({ bookingStatus: "RESTRICTED", restrictionReason: "예약 취소" });
    expect(persisted.actions).toHaveLength(1);
    expect(persisted.audits).toHaveLength(1);
    expect(persisted.sanctions).toHaveLength(1);
    expect(persisted.sanctions[0]).toMatchObject({ status: "ACTIVE", type: "CANCELLATION_RESTRICTION" });
    expect(persisted.peerReservation?.status).toBe("CONFIRMED");
    expect(persisted.peerActions).toEqual([]);
    expect(persisted.peerAudits).toEqual([]);
    expect(persisted.peerSanctions).toEqual([]);
  });

  it("skips restriction effects Given a SHADOW_BANNED student When they cancel their own reservation Then only the reservation is cancelled", async () => {
    // Given
    const seeded = requireFixtures();
    const shadowStudent = await withAdminDatabaseContext(seeded.admin.id, (transaction) =>
      transaction.user.update({
        data: { bookingStatus: "SHADOW_BANNED", restrictionReason: "integration shadow ban" },
        where: { id: seeded.student.id }
      })
    );
    routeAuth.studentUser = sessionUserFor(shadowStudent);

    // When
    const response = await cancelStudentReservation(
      deleteRequest(`/api/reservations/${seeded.ownReservationId}`),
      routeContext(seeded.ownReservationId)
    );

    // Then
    expect(response.status).toBe(200);
    const persisted = await withAdminDatabaseContext(seeded.admin.id, async (transaction) => ({
      actions: await transaction.adminAction.findMany({
        where: { action: "STUDENT_RESERVATION_CANCEL_RESTRICTION", reservationId: seeded.ownReservationId }
      }),
      audits: await transaction.auditLog.findMany({
        where: { action: "STUDENT_RESERVATION_CANCEL_RESTRICTION", userId: seeded.student.id }
      }),
      reservation: await transaction.reservation.findUnique({ where: { id: seeded.ownReservationId } }),
      sanctions: await transaction.userSanction.findMany({
        where: { type: "CANCELLATION_RESTRICTION", userId: seeded.student.id }
      }),
      user: await transaction.user.findUnique({ where: { id: seeded.student.id } })
    }));
    expect(persisted.reservation?.status).toBe("CANCELLED");
    expect(persisted.user).toMatchObject({
      bookingStatus: "SHADOW_BANNED",
      restrictionReason: "integration shadow ban"
    });
    expect(persisted.actions).toEqual([]);
    expect(persisted.audits).toEqual([]);
    expect(persisted.sanctions).toEqual([]);
  });

  it("returns aggregate period availability and only the authenticated student's protected data", async () => {
    const seeded = requireFixtures();

    const periodsResponse = await getStudentPeriods(
      new Request(`https://example.test/api/periods?date=${TEST_DATE}`)
    );
    const profileResponse = await getStudentProfile();
    const studentIsolation = await withStudentDatabaseContext(seeded.student.id, async (transaction) => ({
      peer: await transaction.user.findUnique({ where: { id: seeded.peer.id } }),
      reservations: await transaction.reservation.findMany({ select: { id: true, userId: true } }),
      update: await transaction.reservation.updateMany({
        data: { reason: "cross-user write must fail" },
        where: { id: seeded.peerReservationId }
      })
    }));

    expect(periodsResponse.status).toBe(200);
    const periodsPayload = await periodsResponse.json();
    const periodsBody = JSON.stringify(periodsPayload);
    const periods = StudentPeriodsPayloadSchema.parse(periodsPayload);
    expect(periods.periods.find((period) => period.studyPeriod === "EIGHTH")).toEqual({
      capacity: 5,
      closeTime: "23:59",
      confirmedCount: 2,
      date: TEST_DATE,
      enabled: true,
      label: "8면학",
      myReservationId: seeded.ownReservationId,
      openTime: "00:00",
      remaining: 3,
      studyPeriod: "EIGHTH",
      windowState: "open"
    });
    for (const protectedValue of [
      seeded.peer.id,
      seeded.peer.name,
      seeded.peer.studentNumber,
      seeded.peerReservationId,
      "own private reason",
      "peer private reason"
    ]) {
      expect(periodsBody).not.toContain(protectedValue);
    }
    for (const protectedField of [
      "actor",
      "actorId",
      "applicant",
      "applicants",
      "bookingStatus",
      "generation",
      "id",
      "name",
      "reason",
      "reservationId",
      "riroId",
      "role",
      "studentNumber",
      "targetUser",
      "targetUserId",
      "user",
      "userId"
    ]) {
      expect(periodsBody).not.toContain(`"${protectedField}"`);
    }
    expect(profileResponse.status).toBe(200);
    await expect(profileResponse.json()).resolves.toMatchObject({
      reservationSummary: { confirmedCount: 1 },
      user: { name: seeded.student.name, studentNumber: seeded.student.studentNumber }
    });
    expect(studentIsolation).toEqual({
      peer: null,
      reservations: [{ id: seeded.ownReservationId, userId: seeded.student.id }],
      update: { count: 0 }
    });
  });

  it("returns seeded protected rows from every authorized admin read route", async () => {
    const seeded = requireFixtures();
    const requests = await Promise.all([
      getAdminUsers(new Request("https://example.test/api/admin/users")),
      getAdminUser(
        new Request(`https://example.test/api/admin/users/${seeded.peer.id}`),
        routeContext(seeded.peer.id)
      ),
      getAdminReservations(new Request(`https://example.test/api/admin/reservations?date=${TEST_DATE}`)),
      getAdminStatistics(
        new Request(`https://example.test/api/admin/statistics?from=${TEST_DATE}&to=${TEST_DATE}`)
      ),
      getAdminDashboard(new Request(`https://example.test/api/admin/dashboard?date=${TEST_DATE}`)),
      getAdminActions(new Request("https://example.test/api/admin/actions")),
      getAdminPeriodSettings(new Request(`https://example.test/api/admin/period-settings?date=${TEST_DATE}`))
    ]);

    expect(requests.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    const [users, detail, reservations, statistics, dashboard, actions, settings] = await Promise.all(
      requests.map((response) => response.json())
    );
    expect(users).toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({
          id: seeded.peer.id,
          name: seeded.peer.name,
          studentNumber: seeded.peer.studentNumber
        })
      ])
    });
    expect(detail).toMatchObject({
      adminActions: expect.arrayContaining([
        expect.objectContaining({
          actorId: seeded.admin.id,
          id: "seeded-admin-action",
          reason: "seeded audit reason",
          reservationId: seeded.peerReservationId,
          targetUserId: seeded.peer.id
        })
      ]),
      auditLogs: expect.arrayContaining([
        expect.objectContaining({
          action: "SEEDED_PROTECTED_AUDIT",
          actorId: seeded.admin.id,
          detail: "seeded detail"
        })
      ]),
      reservationHistory: expect.arrayContaining([
        expect.objectContaining({
          id: seeded.peerReservationId,
          reason: "peer private reason",
          status: "CONFIRMED",
          userId: seeded.peer.id
        })
      ]),
      user: {
        id: seeded.peer.id,
        name: seeded.peer.name,
        studentNumber: seeded.peer.studentNumber
      }
    });
    expect(reservations).toMatchObject({
      reservations: expect.arrayContaining([
        expect.objectContaining({
          id: seeded.peerReservationId,
          reason: "peer private reason",
          status: "CONFIRMED",
          user: expect.objectContaining({
            id: seeded.peer.id,
            name: seeded.peer.name,
            studentNumber: seeded.peer.studentNumber
          })
        })
      ])
    });
    expect(statistics).toMatchObject({ statistics: { totals: { confirmedCount: 2, uniqueStudentCount: 2 } } });
    expect(dashboard).toMatchObject({
      periods: expect.arrayContaining([
        expect.objectContaining({
          applicants: expect.arrayContaining([
            {
              name: seeded.peer.name,
              reservationId: seeded.peerReservationId,
              studentNumber: seeded.peer.studentNumber
            }
          ]),
          confirmedCount: 2,
          studyPeriod: "EIGHTH"
        })
      ])
    });
    expect(actions).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({
            id: seeded.admin.id,
            name: seeded.admin.name,
            studentNumber: seeded.admin.studentNumber
          }),
          actorId: seeded.admin.id,
          id: "seeded-admin-action",
          reason: "seeded audit reason",
          reservationId: seeded.peerReservationId,
          targetUser: expect.objectContaining({
            id: seeded.peer.id,
            name: seeded.peer.name,
            studentNumber: seeded.peer.studentNumber
          }),
          targetUserId: seeded.peer.id
        })
      ])
    });
    expect(settings).toEqual({
      periods: [
        {
          applicants: [],
          capacity: 5,
          closeTime: "23:59",
          confirmedCount: 2,
          date: TEST_DATE,
          enabled: true,
          label: "8면학",
          myReservationId: null,
          openTime: "00:00",
          remaining: 3,
          studyPeriod: "EIGHTH",
          windowState: "open"
        },
        {
          applicants: [],
          capacity: 5,
          closeTime: "23:59",
          confirmedCount: 0,
          date: TEST_DATE,
          enabled: true,
          label: "1면학",
          myReservationId: null,
          openTime: "00:00",
          remaining: 5,
          studyPeriod: "FIRST",
          windowState: "open"
        }
      ]
    });
  });

  it("persists admin settings, target reservations, session revocation, and their audit trails", async () => {
    const seeded = requireFixtures();

    const patchResponse = await patchAdminPeriodSettings(
      jsonRequest("/api/admin/period-settings", "PATCH", {
        date: TEST_DATE,
        periods: [
          {
            capacity: 7,
            closeTime: "23:30",
            enabled: true,
            openTime: "00:30",
            studyPeriod: "EIGHTH"
          }
        ]
      })
    );
    const createResponse = await createAdminReservation(
      jsonRequest("/api/admin/reservations", "POST", {
        date: TEST_DATE,
        reason: "관리자 통합 추가",
        studentNumber: seeded.peer.studentNumber,
        studyPeriod: "FIRST"
      })
    );
    const revokeResponse = await revokeAdminUserSessions(
      jsonRequest(`/api/admin/users/${seeded.peer.id}/sessions/revoke`, "POST", {
        reason: "통합 세션 종료"
      }),
      routeContext(seeded.peer.id)
    );

    expect([patchResponse.status, createResponse.status, revokeResponse.status]).toEqual([200, 201, 200]);
    await expect(revokeResponse.json()).resolves.toMatchObject({ revokedSessionCount: 2 });
    const persisted = await withAdminDatabaseContext(seeded.admin.id, async (transaction) => ({
      actions: await transaction.adminAction.findMany({
        where: {
          action: { in: ["PERIOD_SETTINGS_PATCH", "ADMIN_RESERVATION_CREATE", "USER_SESSIONS_REVOKE"] }
        }
      }),
      audits: await transaction.auditLog.findMany({
        where: {
          action: { in: ["PERIOD_SETTINGS_PATCH", "ADMIN_RESERVATION_CREATE", "USER_SESSIONS_REVOKE"] }
        }
      }),
      createdReservation: await transaction.reservation.findUnique({
        where: {
          userId_date_studyPeriod: {
            date: TEST_DATE,
            studyPeriod: "FIRST",
            userId: seeded.peer.id
          }
        }
      }),
      globalSetting: await transaction.periodSetting.findUnique({
        where: { date_studyPeriod: { date: "__global__", studyPeriod: "EIGHTH" } }
      }),
      targetSessionCount: await transaction.session.count({ where: { userId: seeded.peer.id } })
    }));
    expect(persisted.globalSetting).toMatchObject({ capacity: 7, closeTime: "23:30", openTime: "00:30" });
    expect(persisted.createdReservation).toMatchObject({
      reason: "관리자 통합 추가",
      status: "CONFIRMED",
      userId: seeded.peer.id
    });
    expect(persisted.targetSessionCount).toBe(0);
    expect(persisted.actions).toHaveLength(3);
    expect(persisted.audits).toHaveLength(3);
    const patchAction = rowForAction(persisted.actions, "PERIOD_SETTINGS_PATCH");
    const createAction = rowForAction(persisted.actions, "ADMIN_RESERVATION_CREATE");
    const revokeAction = rowForAction(persisted.actions, "USER_SESSIONS_REVOKE");
    expect(patchAction).toMatchObject({
      action: "PERIOD_SETTINGS_PATCH",
      actorId: seeded.admin.id,
      reason: "시간대 설정 변경",
      reservationId: null,
      targetUserId: null
    });
    expect(parseStoredJson(patchAction.after)).toEqual({
      date: TEST_DATE,
      periods: [{ capacity: 7, closeTime: "23:30", enabled: true, openTime: "00:30", studyPeriod: "EIGHTH" }]
    });
    expect(parseStoredJson(patchAction.before)).toEqual({
      date: TEST_DATE,
      periods: [
        { capacity: 5, closeTime: "23:59", date: TEST_DATE, enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" },
        { capacity: 5, closeTime: "23:59", date: TEST_DATE, enabled: true, openTime: "00:00", studyPeriod: "FIRST" }
      ]
    });
    expect(createAction).toMatchObject({
      action: "ADMIN_RESERVATION_CREATE",
      actorId: seeded.admin.id,
      reason: "관리자 통합 추가",
      reservationId: persisted.createdReservation?.id,
      targetUserId: seeded.peer.id
    });
    expect(parseStoredJson(createAction.after)).toEqual({
      date: TEST_DATE,
      reservationStatus: "CONFIRMED",
      studyPeriod: "FIRST"
    });
    expect(revokeAction).toMatchObject({
      action: "USER_SESSIONS_REVOKE",
      actorId: seeded.admin.id,
      reason: "통합 세션 종료",
      reservationId: null,
      targetUserId: seeded.peer.id
    });
    expect(parseStoredJson(revokeAction.before)).toEqual({ activeCount: 2, expiredCount: 0, totalCount: 2 });
    expect(parseStoredJson(revokeAction.after)).toEqual({ revokedSessionCount: 2 });

    const patchAudit = rowForAction(persisted.audits, "PERIOD_SETTINGS_PATCH");
    const createAudit = rowForAction(persisted.audits, "ADMIN_RESERVATION_CREATE");
    const revokeAudit = rowForAction(persisted.audits, "USER_SESSIONS_REVOKE");
    expect(patchAudit).toMatchObject({ action: "PERIOD_SETTINGS_PATCH", actorId: seeded.admin.id, userId: null });
    expect(parseStoredJson(patchAudit.detail)).toEqual({
      actionId: patchAction.id,
      date: TEST_DATE,
      periods: 1,
      scope: "ALL_DATES"
    });
    expect(createAudit).toMatchObject({
      action: "ADMIN_RESERVATION_CREATE",
      actorId: seeded.admin.id,
      userId: seeded.peer.id
    });
    expect(parseStoredJson(createAudit.detail)).toEqual({
      actionId: createAction.id,
      date: TEST_DATE,
      reason: "관리자 통합 추가",
      reservationId: persisted.createdReservation?.id,
      studyPeriod: "FIRST"
    });
    expect(revokeAudit).toMatchObject({
      action: "USER_SESSIONS_REVOKE",
      actorId: seeded.admin.id,
      userId: seeded.peer.id
    });
    expect(parseStoredJson(revokeAudit.detail)).toEqual({
      actionId: revokeAction.id,
      reason: "통합 세션 종료",
      revokedSessionCount: 2
    });
  });

  it("keeps SYSTEM notification, maintenance, and readiness protected reads visible under RLS", async () => {
    const seeded = requireFixtures();
    const period = await prismaClosedPeriodNotificationRepository.getPeriod({
      date: CLOSED_DATE,
      studyPeriod: "EIGHTH"
    });
    const claim = await prismaClosedPeriodNotificationRepository.claimDelivery({
      date: CLOSED_DATE,
      staleSendingBefore: new Date(TEST_NOW.getTime() - 60_000),
      studyPeriod: "EIGHTH"
    });
    if (claim?.updatedAt === undefined) {
      throw new Error("Expected a claimed PostgreSQL notification delivery");
    }
    const saved = await prismaClosedPeriodNotificationRepository.saveDelivery({
      claimUpdatedAt: claim.updatedAt,
      date: CLOSED_DATE,
      failureCode: null,
      lastError: null,
      messageIds: ["integration-message"],
      nextAttemptAt: null,
      status: "SENT",
      studyPeriod: "EIGHTH"
    });
    const persistedDelivery = await withSystemDatabaseContext((transaction) =>
      transaction.notificationDelivery.findUnique({
        where: {
          date_studyPeriod_kind: {
            date: CLOSED_DATE,
            kind: "CLOSED_LIST",
            studyPeriod: "EIGHTH"
          }
        }
      })
    );
    const csrfCleanup = await prismaMaintenanceCleanupStore.deleteExpiredCsrfTokens(TEST_NOW);
    const rateLimitCleanup = await prismaMaintenanceCleanupStore.deleteExpiredRateLimitBuckets(TEST_NOW);
    const sessionCleanup = await prismaMaintenanceCleanupStore.deleteExpiredSessions(TEST_NOW);
    const cleanupState = await withSystemDatabaseContext(async (transaction) => ({
      expiredCsrfCount: await transaction.csrfToken.count({ where: { expiresAt: { lte: TEST_NOW } } }),
      expiredRateLimitCount: await transaction.rateLimitBucket.count({ where: { expiresAt: { lte: TEST_NOW } } }),
      expiredSessionCount: await transaction.session.count({ where: { expiresAt: { lte: TEST_NOW } } }),
      peerSessions: await transaction.session.findMany({
        orderBy: { id: "asc" },
        select: { id: true, userId: true },
        where: { userId: seeded.peer.id }
      })
    }));
    const jobStartedAt = TEST_NOW;
    const jobFinishedAt = new Date(TEST_NOW.getTime() + 1_250);
    const startedJob = await prismaOperationalJobStore.tryStart({
      job: "MAINTENANCE",
      startedAt: jobStartedAt,
      timeoutMs: 15 * 60_000
    });
    const finishedJob = await prismaOperationalJobStore.finish({
      backlogCount: 0,
      durationMs: 1_250,
      failureCode: null,
      finishedAt: jobFinishedAt,
      job: "MAINTENANCE",
      oldestBacklogAt: null,
      result: JSON.stringify({ processedCount: 3 }),
      startedAt: jobStartedAt,
      succeeded: true
    });
    const persistedJob = await withSystemDatabaseContext((transaction) =>
      transaction.operationalJob.findUnique({ where: { job: "MAINTENANCE" } })
    );
    const readiness = await getPrismaReadinessReport(jobFinishedAt);

    expect(period).toMatchObject({
      applicants: expect.arrayContaining([expect.objectContaining({ studentNumber: "test-route-peer" })]),
      confirmedCount: 1,
      date: CLOSED_DATE
    });
    expect(claim).toMatchObject({ status: "SENDING" });
    expect(saved).toMatchObject({ messageIds: ["integration-message"], status: "SENT" });
    expect(persistedDelivery).toMatchObject({
      attempts: 1,
      messageIds: '["integration-message"]',
      status: "SENT"
    });
    expect(csrfCleanup).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 0 });
    expect(rateLimitCleanup).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 0 });
    expect(sessionCleanup).toEqual({ hasMore: false, processedCount: 1, remainingLowerBound: 0 });
    expect(cleanupState).toEqual({
      expiredCsrfCount: 0,
      expiredRateLimitCount: 0,
      expiredSessionCount: 0,
      peerSessions: [
        { id: "peer-session-one", userId: seeded.peer.id },
        { id: "peer-session-two", userId: seeded.peer.id }
      ]
    });
    expect(startedJob).toMatchObject({
      finishedAt: null,
      job: "MAINTENANCE",
      lastAttemptAt: jobStartedAt,
      startedAt: jobStartedAt,
      status: "RUNNING"
    });
    expect(finishedJob).toMatchObject({
      backlogCount: 0,
      consecutiveFailures: 0,
      durationMs: 1_250,
      failureCode: null,
      finishedAt: jobFinishedAt,
      job: "MAINTENANCE",
      lastSuccessAt: jobFinishedAt,
      result: JSON.stringify({ processedCount: 3 }),
      startedAt: jobStartedAt,
      status: "SUCCEEDED"
    });
    expect(persistedJob).toMatchObject({
      finishedAt: jobFinishedAt,
      job: "MAINTENANCE",
      lastSuccessAt: jobFinishedAt,
      result: JSON.stringify({ processedCount: 3 }),
      startedAt: jobStartedAt,
      status: "SUCCEEDED"
    });
    expect(readiness.checks.database).toEqual({ code: "ok", status: "ok" });
    expect(readiness.checks.jobs.CLOSED_PERIOD_NOTIFICATIONS.code).toBe("healthy");
    expect(readiness.checks.jobs.MAINTENANCE.code).toBe("healthy");
  });
});

async function seedProtectedFixtures(): Promise<TestFixtures> {
  const [admin, student, peer] = await Promise.all([
    seedUser({ id: "route-admin", role: "ADMIN" }),
    seedUser({ id: "route-student" }),
    seedUser({ id: "route-peer" })
  ]);
  await withSystemDatabaseContext(async (transaction) => {
    await transaction.periodSetting.createMany({
      data: [
        { capacity: 5, closeTime: "23:59", date: TEST_DATE, enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" },
        { capacity: 5, closeTime: "23:59", date: TEST_DATE, enabled: true, openTime: "00:00", studyPeriod: "FIRST" },
        { capacity: 5, closeTime: "00:01", date: CLOSED_DATE, enabled: true, openTime: "00:00", studyPeriod: "EIGHTH" }
      ]
    });
    await transaction.reservation.createMany({
      data: [
        { id: "own-protected-reservation", date: TEST_DATE, reason: "own private reason", status: "CONFIRMED", studyPeriod: "EIGHTH", userId: student.id },
        { id: "peer-protected-reservation", date: TEST_DATE, reason: "peer private reason", status: "CONFIRMED", studyPeriod: "EIGHTH", userId: peer.id },
        { id: "closed-peer-reservation", date: CLOSED_DATE, reason: "closed list reason", status: "CONFIRMED", studyPeriod: "EIGHTH", userId: peer.id }
      ]
    });
    await transaction.adminAction.create({
      data: {
        action: "SEEDED_PROTECTED_ACTION",
        actorId: admin.id,
        id: "seeded-admin-action",
        reason: "seeded audit reason",
        reservationId: "peer-protected-reservation",
        targetUserId: peer.id
      }
    });
    await transaction.auditLog.create({
      data: { action: "SEEDED_PROTECTED_AUDIT", actorId: admin.id, detail: "seeded detail", userId: peer.id }
    });
    await transaction.session.createMany({
      data: [
        { expiresAt: new Date("2026-08-10T02:00:00.000Z"), id: "expired-session", tokenHash: "expired-token", userId: student.id },
        { expiresAt: new Date("2026-08-11T03:00:00.000Z"), id: "peer-session-one", tokenHash: "peer-token-one", userId: peer.id },
        { expiresAt: new Date("2026-08-11T04:00:00.000Z"), id: "peer-session-two", tokenHash: "peer-token-two", userId: peer.id }
      ]
    });
    await transaction.csrfToken.create({
      data: { expiresAt: new Date("2026-08-10T02:00:00.000Z"), sessionId: "expired-session", tokenHash: "expired-csrf" }
    });
    await transaction.rateLimitBucket.create({
      data: { count: 1, expiresAt: new Date("2026-08-10T02:00:00.000Z"), key: "expired-rate", windowStart: new Date("2026-08-10T01:00:00.000Z") }
    });
    await transaction.notificationSetting.create({
      data: { closedPeriodNotificationsEnabled: true, id: "global", reservationCreatedNotificationsEnabled: false }
    });
    await transaction.operationalJob.createMany({
      data: ["CLOSED_PERIOD_NOTIFICATIONS", "MAINTENANCE"].map((job) => ({
        finishedAt: new Date(TEST_NOW.getTime() - 30_000),
        job,
        lastAttemptAt: new Date(TEST_NOW.getTime() - 60_000),
        lastSuccessAt: new Date(TEST_NOW.getTime() - 30_000),
        startedAt: new Date(TEST_NOW.getTime() - 90_000),
        status: "SUCCEEDED"
      }))
    });
  });
  return {
    admin,
    ownReservationId: "own-protected-reservation",
    peer,
    peerReservationId: "peer-protected-reservation",
    student
  };
}

function sessionUserFor(user: User): SessionUser {
  return {
    bookingStatus: user.bookingStatus,
    generation: user.generation,
    id: user.id,
    name: user.name,
    restrictionReason: user.restrictionReason,
    restrictedUntil: user.restrictedUntil?.toISOString() ?? null,
    role: user.role,
    shadowBanProfile: user.shadowBanProfile,
    studentNumber: user.studentNumber
  };
}

function sessionFor(user: User, id: string): CurrentSession {
  return { id, user: sessionUserFor(user) };
}

function requireFixtures(): TestFixtures {
  if (fixtures === null) {
    throw new Error("PostgreSQL fixtures were not seeded");
  }
  return fixtures;
}

function routeContext(id: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(path: string, method: "PATCH" | "POST", body: unknown): Request {
  return new Request(`https://example.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
      "x-csrf-token": "integration-csrf"
    },
    method
  });
}

function deleteRequest(path: string): Request {
  return new Request(`https://example.test${path}`, {
    headers: { origin: "https://example.test", "x-csrf-token": "integration-csrf" },
    method: "DELETE"
  });
}

async function assertRestrictedRuntimePrerequisite(): Promise<void> {
  const roles = await prisma.$queryRaw<
    readonly {
      readonly bypassRls: boolean;
      readonly currentUser: string;
      readonly superuser: boolean;
    }[]
  >`
    SELECT current_user AS "currentUser", rolbypassrls AS "bypassRls", rolsuper AS "superuser"
    FROM pg_roles
    WHERE rolname = current_user
  `;
  const role = roles[0];
  if (role?.currentUser !== "info_room_runtime" || role.bypassRls || role.superuser) {
    throw new Error(
      `PostgreSQL integration prerequisite failed: expected current_user=info_room_runtime, rolbypassrls=false, rolsuper=false; received ${JSON.stringify(role ?? null)}`
    );
  }
}

function rowForAction<TRow extends { readonly action: string }>(rows: readonly TRow[], action: string): TRow {
  const matches = rows.filter((row) => row.action === action);
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`Expected exactly one newly persisted ${action} row, received ${matches.length}`);
  }
  return match;
}

function parseStoredJson(value: string | null): Readonly<Record<string, unknown>> {
  return StoredJsonObjectSchema.parse(JSON.parse(z.string().parse(value)));
}
