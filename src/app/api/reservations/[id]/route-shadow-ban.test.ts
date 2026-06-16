import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { MockCancelResult, MockReservation } from "@/lib/mock-reservation-state";
import type { Reservation } from "@/lib/reservation-service";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReservationFindUnique = (input: unknown) => Promise<Reservation | null>;
type ReservationUpdate = (input: unknown) => Promise<Reservation>;
type UserUpdate = (input: unknown) => Promise<unknown>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type WriteMutation = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: WriteMutation };
  readonly reservation: { readonly findUnique: ReservationFindUnique; readonly update: ReservationUpdate };
  readonly user: { readonly update: UserUpdate };
  readonly userSanction: { readonly create: WriteMutation; readonly updateMany: WriteMutation };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;
type RequireMutatingRequestSafety = (request: Request) => null;
type EnforceReservationRateLimit = (request: Request, userId: string) => Promise<RateLimitResult>;
type RequireSession = () => Promise<CurrentSession>;
type IsNoDatabaseMockMode = () => boolean;
type CancelMockReservation = (input: { readonly id: string; readonly now: Date; readonly user: SessionUser }) => MockCancelResult;
type CreateMockSessionToken = (user: SessionUser) => string;
type SetSessionCookie = (response: Response, token: string) => void;

const routeMocks = vi.hoisted(() => {
  class UnauthorizedSessionError extends Error {
    public constructor() {
      super("로그인이 필요합니다.");
      this.name = "UnauthorizedSessionError";
    }
  }

  return {
    UnauthorizedSessionError,
    adminActionCreate: vi.fn<AdminActionCreate>(),
    auditLogCreate: vi.fn<WriteMutation>(),
    cancelMockReservation: vi.fn<CancelMockReservation>(),
    createMockSessionToken: vi.fn<CreateMockSessionToken>(),
    enforceReservationRateLimit: vi.fn<EnforceReservationRateLimit>(),
    isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
    requireMutatingRequestSafety: vi.fn<RequireMutatingRequestSafety>(),
    requireSession: vi.fn<RequireSession>(),
    reservationFindUnique: vi.fn<ReservationFindUnique>(),
    reservationUpdate: vi.fn<ReservationUpdate>(),
    setSessionCookie: vi.fn<SetSessionCookie>(),
    transaction: vi.fn<PrismaTransaction>(),
    userSanctionCreate: vi.fn<WriteMutation>(),
    userSanctionUpdateMany: vi.fn<WriteMutation>(),
    userUpdate: vi.fn<UserUpdate>(),
    validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  cancelMockReservation: routeMocks.cancelMockReservation
}));

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));

vi.mock("@/lib/request-security", () => ({
  requireMutatingRequestSafety: routeMocks.requireMutatingRequestSafety
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceReservationRateLimit: routeMocks.enforceReservationRateLimit
}));

vi.mock("@/lib/session", () => ({
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  createMockSessionToken: routeMocks.createMockSessionToken,
  requireSession: routeMocks.requireSession,
  setSessionCookie: routeMocks.setSessionCookie
}));

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-17T00:00:00.000Z")
};

const shadowBannedStudent: SessionUser = {
  bookingStatus: "SHADOW_BANNED",
  generation: 31,
  id: "student-shadow",
  name: "테스트학생",
  restrictionReason: "블랙리스트",
  restrictedUntil: "2026-07-01T00:00:00.000Z",
  role: "STUDENT",
  studentNumber: "31001"
};

const confirmedReservation: Reservation = {
  date: "2026-06-17",
  id: "reservation-shadow",
  reason: "자습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: shadowBannedStudent.id
};

const cancelledReservation: Reservation = {
  ...confirmedReservation,
  status: "CANCELLED"
};

describe("student reservation cancellation shadow-ban handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();

    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireSession.mockResolvedValue({ id: "session-shadow", user: shadowBannedStudent });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceReservationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.reservationFindUnique.mockResolvedValue(confirmedReservation);
    routeMocks.reservationUpdate.mockResolvedValue(cancelledReservation);
    routeMocks.userUpdate.mockResolvedValue({
      ...shadowBannedStudent,
      bookingStatus: "RESTRICTED",
      restrictedUntil: new Date("2026-06-20T00:00:00.000Z"),
      restrictionReason: "예약 취소"
    });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-cancel" });
    routeMocks.userSanctionCreate.mockResolvedValue({});
    routeMocks.userSanctionUpdateMany.mockResolvedValue({});
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
    routeMocks.createMockSessionToken.mockImplementation((user) => {
      const payload = { id: `mock-session-${user.id}`, user };
      return `mock.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
    });
    routeMocks.setSessionCookie.mockImplementation((response, token) => {
      response.headers.append("Set-Cookie", `info_room_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
    });
  });

  it("does not downgrade a database shadow-ban when the student cancels an existing reservation", async () => {
    const { DELETE } = await loadCancelRoute();

    const response = await DELETE(deleteRequest(), routeContext(confirmedReservation.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reservation: { id: confirmedReservation.id, status: "CANCELLED" } });
    expect(routeMocks.reservationUpdate).toHaveBeenCalledWith({
      data: { status: "CANCELLED" },
      where: { id: confirmedReservation.id }
    });
    expect(routeMocks.userUpdate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
    expect(routeMocks.userSanctionCreate).not.toHaveBeenCalled();
    expect(routeMocks.userSanctionUpdateMany).not.toHaveBeenCalled();
    expect(routeMocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("masks mock shadow-ban cancellation responses and the refreshed mock session cookie", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.cancelMockReservation.mockReturnValue({
      kind: "cancelled",
      reservation: mockCancelledReservation(),
      user: shadowBannedStudent
    });
    const { DELETE } = await loadCancelRoute();

    const response = await DELETE(deleteRequest(), routeContext(confirmedReservation.id));

    expect(response.status).toBe(200);
    expect(routeMocks.createMockSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ bookingStatus: "ACTIVE", restrictedUntil: null, restrictionReason: null })
    );
    expect(routeMocks.setSessionCookie).toHaveBeenCalledWith(response, expect.stringMatching(/^mock\./u));
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      user: {
        bookingStatus: "ACTIVE",
        restrictionReason: null,
        restrictedUntil: null
      }
    });
    expect(text).not.toContain("SHADOW_BANNED");
    expect(text).not.toContain("블랙리스트");
    expect(text).not.toContain("2026-07-01");
    const decodedCookie = decodeMockSessionCookie(response);
    expect(decodedCookie).toContain('"bookingStatus":"ACTIVE"');
    expect(decodedCookie).toContain('"restrictionReason":null');
    expect(decodedCookie).toContain('"restrictedUntil":null');
    expect(decodedCookie).not.toContain("SHADOW_BANNED");
    expect(decodedCookie).not.toContain("블랙리스트");
    expect(decodedCookie).not.toContain("2026-07-01");
  });
});

function transactionClient(): TransactionClient {
  return {
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    reservation: { findUnique: routeMocks.reservationFindUnique, update: routeMocks.reservationUpdate },
    user: { update: routeMocks.userUpdate },
    userSanction: { create: routeMocks.userSanctionCreate, updateMany: routeMocks.userSanctionUpdateMany }
  };
}

async function loadCancelRoute(): Promise<{ readonly DELETE: typeof import("./route").DELETE }> {
  return import("./route");
}

function deleteRequest(): Request {
  return new Request("https://example.test/api/reservations/reservation-shadow", {
    headers: {
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "DELETE"
  });
}

function routeContext(id: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function mockCancelledReservation(): MockReservation {
  return {
    ...cancelledReservation,
    createdAt: new Date("2026-06-16T00:00:00.000Z"),
    user: {
      bookingStatus: "SHADOW_BANNED",
      id: shadowBannedStudent.id,
      name: shadowBannedStudent.name,
      role: shadowBannedStudent.role,
      studentNumber: shadowBannedStudent.studentNumber
    }
  };
}

function decodeMockSessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookieValue = setCookie.match(/info_room_session=([^;]+)/u)?.[1] ?? "";
  const encodedPayload = cookieValue.replace(/^mock\./u, "");
  return Buffer.from(encodedPayload, "base64url").toString("utf8");
}
