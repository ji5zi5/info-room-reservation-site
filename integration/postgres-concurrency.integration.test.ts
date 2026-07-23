import type { User } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentSession, SessionUser } from "@/lib/session";

import { prisma, resetPostgresTestDatabase, seedUser } from "./postgres-test-db";

type RouteAuthState = {
  adminSession: CurrentSession | null;
  studentSession: CurrentSession | null;
};

const routeAuth = vi.hoisted<RouteAuthState>(() => ({
  adminSession: null,
  studentSession: null
}));

vi.mock("@/lib/session", () => {
  class UnauthorizedSessionError extends Error {}
  class ForbiddenSessionError extends Error {}

  return {
    createMockSessionToken: vi.fn(() => "mock-session"),
    ForbiddenSessionError,
    requireAdminSession: vi.fn(async () => {
      if (!routeAuth.adminSession) {
        throw new UnauthorizedSessionError("관리자 로그인이 필요합니다.");
      }
      return routeAuth.adminSession;
    }),
    requireSession: vi.fn(async () => {
      if (!routeAuth.studentSession) {
        throw new UnauthorizedSessionError("로그인이 필요합니다.");
      }
      return routeAuth.studentSession;
    }),
    setSessionCookie: vi.fn(),
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
  enforceAdminMutationRateLimit: vi.fn(async () => allowedRateLimit()),
  enforceReservationRateLimit: vi.fn(async () => allowedRateLimit())
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: vi.fn(() => false)
}));

import { POST as markNoShow } from "@/app/api/admin/reservations/[id]/no-show/route";
import { POST as restrictUser } from "@/app/api/admin/users/[id]/restriction/route";
import { DELETE as cancelReservation } from "@/app/api/reservations/[id]/route";
import { prismaReservationStore } from "@/lib/prisma-reservation-store";
import { reserveStudyPeriod } from "@/lib/reservation-service";

const TEST_WINDOW = futureMondayWindow();
const TEST_NOW = TEST_WINDOW.now;
const TEST_DATE = TEST_WINDOW.reservationDate;

beforeEach(async () => {
  routeAuth.adminSession = null;
  routeAuth.studentSession = null;
  await resetPostgresTestDatabase();
});

afterAll(async () => {
  await resetPostgresTestDatabase();
  await prisma.$disconnect();
});

describe("real PostgreSQL mutation serialization", () => {
  it("allows exactly one winner for the last seat", async () => {
    const users = await Promise.all([seedUser({ id: "last-seat-a" }), seedUser({ id: "last-seat-b" })]);
    await seedPeriod(1);

    const results = await Promise.all(users.map((user) => reserve(user.id)));

    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "error" && result.reason === "full")).toHaveLength(1);
    await expect(
      prisma.reservation.count({
        where: { date: TEST_DATE, status: "CONFIRMED", studyPeriod: "EIGHTH" }
      })
    ).resolves.toBe(1);
  });

  it("revives one cancelled identity exactly once", async () => {
    const user = await seedUser({ id: "revive-user" });
    await seedPeriod(10);
    await prisma.reservation.create({
      data: {
        date: TEST_DATE,
        reason: "이전 취소",
        status: "CANCELLED",
        studyPeriod: "EIGHTH",
        userId: user.id
      }
    });

    const results = await Promise.all([reserve(user.id), reserve(user.id)]);

    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "error" && result.reason === "duplicate")).toHaveLength(1);
    await expect(
      prisma.reservation.count({ where: { date: TEST_DATE, studyPeriod: "EIGHTH", userId: user.id } })
    ).resolves.toBe(1);
  });

  it("creates cancellation sanctions once under duplicate requests", async () => {
    const user = await seedUser({ id: "cancel-user" });
    const reservation = await seedReservation(user.id);
    routeAuth.studentSession = sessionFor(user, "student-session");

    const responses = await Promise.all([
      cancelReservation(deleteRequest(reservation.id), routeContext(reservation.id)),
      cancelReservation(deleteRequest(reservation.id), routeContext(reservation.id))
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(prisma.adminAction.count()).resolves.toBe(1);
    await expect(prisma.auditLog.count()).resolves.toBe(1);
    await expect(prisma.userSanction.count()).resolves.toBe(1);
    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({
      status: "CANCELLED"
    });
  });

  it("lets only one terminal transition win between cancel and no-show", async () => {
    const [admin, user] = await Promise.all([
      seedUser({ id: "transition-admin", role: "ADMIN" }),
      seedUser({ id: "transition-user" })
    ]);
    const reservation = await seedReservation(user.id);
    routeAuth.adminSession = sessionFor(admin, "admin-session");
    routeAuth.studentSession = sessionFor(user, "student-session");

    const responses = await Promise.all([
      cancelReservation(deleteRequest(reservation.id), routeContext(reservation.id)),
      markNoShow(
        jsonRequest(`/api/admin/reservations/${reservation.id}/no-show`, "POST", {
          reason: "통합 노쇼"
        }),
        routeContext(reservation.id)
      )
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await expect(prisma.adminAction.count()).resolves.toBe(1);
    await expect(prisma.auditLog.count()).resolves.toBe(1);
    await expect(prisma.userSanction.count()).resolves.toBe(1);
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(["CANCELLED", "NO_SHOW"]).toContain(stored.status);
  });

  it("leaves no confirmed reservation when a ban races creation", async () => {
    const [admin, user] = await Promise.all([
      seedUser({ id: "ban-admin", role: "ADMIN" }),
      seedUser({ id: "ban-user" })
    ]);
    await seedPeriod(10);
    routeAuth.adminSession = sessionFor(admin, "admin-session");

    const [, restrictionResponse] = await Promise.all([
      reserve(user.id),
      restrictUser(
        jsonRequest(`/api/admin/users/${user.id}/restriction`, "POST", {
          days: null,
          reason: "통합 운영 제한",
          status: "BANNED"
        }),
        routeContext(user.id)
      )
    ]);

    expect(restrictionResponse.status).toBe(200);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      bookingStatus: "BANNED"
    });
    await expect(
      prisma.reservation.count({ where: { status: "CONFIRMED", userId: user.id } })
    ).resolves.toBe(0);
    await expect(prisma.adminAction.count()).resolves.toBe(1);
    await expect(prisma.userSanction.count()).resolves.toBe(1);
  });
});

function allowedRateLimit(): {
  readonly kind: "allowed";
  readonly remaining: number;
  readonly resetAt: Date;
} {
  return { kind: "allowed", remaining: 99, resetAt: new Date(Date.now() + 60_000) };
}

function deleteRequest(reservationId: string): Request {
  return new Request(`https://example.test/api/reservations/${reservationId}`, {
    headers: mutationHeaders(),
    method: "DELETE"
  });
}

function jsonRequest(path: string, method: "POST", body: unknown): Request {
  const headers = mutationHeaders();
  headers.set("content-type", "application/json");
  return new Request(`https://example.test${path}`, {
    body: JSON.stringify(body),
    headers,
    method
  });
}

function mutationHeaders(): Headers {
  return new Headers({
    origin: "https://example.test",
    "x-csrf-token": "integration-csrf"
  });
}

function reserve(userId: string) {
  return reserveStudyPeriod({
    date: TEST_DATE,
    now: TEST_NOW,
    reason: "통합 예약",
    store: prismaReservationStore,
    studyPeriod: "EIGHTH",
    userId
  });
}

function routeContext(id: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function seedPeriod(capacity: number): Promise<void> {
  await prisma.periodSetting.create({
    data: {
      capacity,
      closeTime: "23:59",
      date: TEST_DATE,
      enabled: true,
      openTime: "00:00",
      studyPeriod: "EIGHTH"
    }
  });
}

async function seedReservation(userId: string) {
  return prisma.reservation.create({
    data: {
      date: TEST_DATE,
      reason: "통합 예약",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH",
      userId
    }
  });
}

function sessionFor(user: User, id: string): CurrentSession {
  const sessionUser: SessionUser = {
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
  return { id, user: sessionUser };
}

function futureMondayWindow(): {
  readonly now: Date;
  readonly reservationDate: string;
} {
  const now = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 0, 1, 3));
  const daysUntilMonday = (8 - now.getUTCDay()) % 7;
  now.setUTCDate(now.getUTCDate() + daysUntilMonday);
  const reservationDate = new Date(now.getTime() + 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  return { now, reservationDate };
}
