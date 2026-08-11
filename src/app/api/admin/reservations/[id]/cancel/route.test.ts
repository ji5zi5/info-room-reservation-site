import { Prisma, type Reservation } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdministratorCancellationInput,
  AdministratorCancellationResult
} from "@/lib/admin-reservation-operations";
import type { CsrfValidationResult } from "@/lib/csrf";
import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type MockReservationRow = {
  readonly id: string;
  readonly status: string;
  readonly userId: string;
};
type MockCancellationResult =
  | { readonly kind: "cancelled"; readonly reservation: MockReservationRow; readonly user: SessionUser }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_cancellable"; readonly reservation: MockReservationRow; readonly user: SessionUser }
  | { readonly kind: "not_found" };

const routeMocks = vi.hoisted(() => ({
  cancelAdministratorReservation: vi.fn<
    (input: AdministratorCancellationInput) => Promise<AdministratorCancellationResult>
  >(),
  cancelMockReservation: vi.fn<(input: unknown) => MockCancellationResult>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  validateRequestCsrf: vi.fn<(request: Request, sessionId: string) => Promise<CsrfValidationResult>>()
}));

vi.mock("@/lib/admin-reservation-operations", () => ({
  cancelAdministratorReservation: routeMocks.cancelAdministratorReservation
}));
vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: routeMocks.validateRequestCsrf
}));
vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode }));
vi.mock("@/lib/mock-reservation-data", () => ({ cancelMockReservation: routeMocks.cancelMockReservation }));
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

const reservation: Reservation & { readonly status: "CANCELLED" } = {
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
  date: "2026-08-12",
  id: "reservation-1",
  reason: "자습",
  status: "CANCELLED",
  studyPeriod: "EIGHTH",
  updatedAt: new Date("2026-08-11T00:00:00.000Z"),
  userId: "student-1"
};

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-08-11T00:01:00.000Z")
};

describe("admin reservation cancel route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.cancelAdministratorReservation.mockResolvedValue({ kind: "ok", reservation });
    routeMocks.cancelMockReservation.mockReturnValue({ kind: "not_found" });
  });

  it("passes explicit web actor, source, provenance, reason, and reservation ID to the locked service", async () => {
    // Given
    const reason = "행사 준비로 정보실 사용 불가";

    // When
    const response = await POST(cancelRequest({ reason }), cancelContext());

    // Then
    expect(response.status).toBe(200);
    expect(routeMocks.cancelAdministratorReservation).toHaveBeenCalledWith({
      actor: { id: adminUser.id, role: "ADMIN" },
      ipHash: expect.any(String),
      reason,
      reservationId: reservation.id,
      source: { kind: "WEB_ADMIN" }
    });
    await expect(response.json()).resolves.toMatchObject({
      reservation: { id: reservation.id, status: "CANCELLED" }
    });
  });

  it.each([
    ["not_found", 404, "not_found", "예약을 찾을 수 없습니다."],
    ["invalid_status", 409, "bad_request", "이미 처리된 예약은 관리자 취소로 변경할 수 없습니다."]
  ] as const)("maps the %s service result to the existing response", async (kind, status, code, message) => {
    // Given
    routeMocks.cancelAdministratorReservation.mockResolvedValue({ kind });

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code, message } });
  });

  it("maps only an exhausted P2034 service conflict to the existing 409 response", async () => {
    // Given
    routeMocks.cancelAdministratorReservation.mockRejectedValue(
      new TransactionRetryExhaustedError(serializableConflict())
    );

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "bad_request" } });
  });

  it.each([
    ["non-serializable exhausted cause", new TransactionRetryExhaustedError(new Error("connection lost"))],
    ["unknown service failure", new Error("unknown failure")]
  ])("keeps %s on the server-error path", async (_label, failure) => {
    // Given
    routeMocks.cancelAdministratorReservation.mockRejectedValue(failure);

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "server_error" } });
  });

  it("rejects a blank reason before either cancellation implementation", async () => {
    // When
    const response = await POST(cancelRequest({ reason: "   " }), cancelContext());

    // Then
    expect(response.status).toBe(400);
    expect(routeMocks.cancelAdministratorReservation).not.toHaveBeenCalled();
    expect(routeMocks.cancelMockReservation).not.toHaveBeenCalled();
  });

  it("preserves the CSRF failure response before rate limiting and cancellation", async () => {
    // Given
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "error", reason: "csrf_invalid" });

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "csrf_invalid" } });
    expect(routeMocks.enforceAdminMutationRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.cancelAdministratorReservation).not.toHaveBeenCalled();
  });

  it("preserves the rate-limit response before cancellation", async () => {
    // Given
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "blocked",
      limit: 10,
      resetAt: new Date("2026-08-11T00:01:00.000Z")
    });

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(429);
    expect(routeMocks.cancelAdministratorReservation).not.toHaveBeenCalled();
  });

  it.each([
    ["cancelled", { kind: "cancelled", reservation, user: adminUser }, 200, undefined],
    ["not_found", { kind: "not_found" }, 404, "not_found"],
    ["not_cancellable", { kind: "not_cancellable", reservation, user: adminUser }, 409, "bad_request"],
    ["forbidden", { kind: "forbidden" }, 403, "forbidden"]
  ] as const)("preserves the %s no-database mock result", async (_label, result, status, code) => {
    // Given
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.cancelMockReservation.mockReturnValue(result);

    // When
    const response = await POST(cancelRequest({ reason: "운영 취소" }), cancelContext());

    // Then
    expect(response.status).toBe(status);
    expect(routeMocks.cancelAdministratorReservation).not.toHaveBeenCalled();
    if (code) {
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }
  });
});

function serializableConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    clientVersion: "test",
    code: "P2034"
  });
}

function cancelRequest(body: unknown): Request {
  return new Request("https://example.test/api/admin/reservations/reservation-1/cancel", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-csrf-token": "csrf-token", origin: "https://example.test" },
    method: "POST"
  });
}

function cancelContext(): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id: reservation.id }) };
}
