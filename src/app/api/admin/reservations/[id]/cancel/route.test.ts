import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReservationRow = {
  readonly id: string;
  readonly status: string;
  readonly userId: string;
};
type ReservationFindUnique = (input: unknown) => Promise<ReservationRow | null>;
type ReservationUpdate = (input: unknown) => Promise<ReservationRow>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
  readonly reservation: {
    readonly findUnique: ReservationFindUnique;
    readonly update: ReservationUpdate;
  };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type RequireAdminSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<AdminActionCreate>(),
  auditLogCreate: vi.fn<AuditLogCreate>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  reservationFindUnique: vi.fn<ReservationFindUnique>(),
  reservationUpdate: vi.fn<ReservationUpdate>(),
  transaction: vi.fn<PrismaTransaction>(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction
  }
}));

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));

vi.mock("@/lib/request-security", () => ({
  requireMutatingRequestSafety: routeMocks.requireMutatingRequestSafety
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceAdminMutationRateLimit: routeMocks.enforceAdminMutationRateLimit
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdminSession: routeMocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { POST } from "./route";

const adminUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
};

const reservation = {
  id: "reservation-1",
  status: "CONFIRMED",
  userId: "student-1"
} satisfies ReservationRow;

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-16T00:01:00.000Z")
};

describe("admin reservation cancel route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.reservationFindUnique.mockResolvedValue(reservation);
    routeMocks.reservationUpdate.mockResolvedValue({ ...reservation, status: "CANCELLED" });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-cancel" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("stores the admin cancellation reason in the action and audit log", async () => {
    const response = await POST(cancelRequest({ reason: "행사 준비로 정보실 사용 불가" }), cancelContext());

    expect(response.status).toBe(200);
    expect(routeMocks.adminActionCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CANCEL",
        actorId: adminUser.id,
        after: JSON.stringify({ reservationStatus: "CANCELLED" }),
        before: JSON.stringify({ reservationStatus: "CONFIRMED" }),
        ipHash: expect.any(String),
        reason: "행사 준비로 정보실 사용 불가",
        reservationId: reservation.id,
        targetUserId: reservation.userId
      }
    });
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "ADMIN_RESERVATION_CANCEL",
        actorId: adminUser.id,
        detail: JSON.stringify({
          actionId: "action-cancel",
          reason: "행사 준비로 정보실 사용 불가",
          reservationId: reservation.id
        }),
        userId: reservation.userId
      }
    });
  });

  it("rejects an admin cancellation without a reason before mutating reservations", async () => {
    const response = await POST(cancelRequest({ reason: "   " }), cancelContext());

    expect(response.status).toBe(400);
    expect(routeMocks.transaction).not.toHaveBeenCalled();
  });
});

function transactionClient(): TransactionClient {
  return {
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    reservation: {
      findUnique: routeMocks.reservationFindUnique,
      update: routeMocks.reservationUpdate
    }
  };
}

function cancelRequest(body: unknown): Request {
  return new Request("https://example.test/api/admin/reservations/reservation-1/cancel", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "POST"
  });
}

function cancelContext(): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id: reservation.id }) };
}
