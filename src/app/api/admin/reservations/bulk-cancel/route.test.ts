import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdministratorBulkCancellationInput, AdministratorBulkCancellationResult } from "@/lib/admin-bulk-cancellation";
import type { CsrfValidationResult } from "@/lib/csrf";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

const routeMocks = vi.hoisted(() => ({
  bulkCancelAdministratorReservations: vi.fn<
    (input: AdministratorBulkCancellationInput) => Promise<AdministratorBulkCancellationResult>
  >(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  requireAdminSession: vi.fn<() => Promise<CurrentSession>>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  scheduleDiscordOperationsBoardSync: vi.fn(),
  validateRequestCsrf: vi.fn<(request: Request, sessionId: string) => Promise<CsrfValidationResult>>()
}));

vi.mock("@/lib/admin-bulk-cancellation", () => ({
  bulkCancelAdministratorReservations: routeMocks.bulkCancelAdministratorReservations
}));
vi.mock("@/lib/discord-operations-board-after-mutation", () => ({
  scheduleDiscordOperationsBoardSync: routeMocks.scheduleDiscordOperationsBoardSync
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
const serviceResult: AdministratorBulkCancellationResult = {
  results: [
    { reservationId: "reservation-1", status: "cancelled" },
    { reservationId: "reservation-2", status: "invalid_status" }
  ],
  summary: { cancelled: 1, conflict: 0, invalidStatus: 1, notFound: 0, total: 2 }
};
const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-08-11T00:01:00.000Z")
};

describe("admin bulk reservation cancellation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.bulkCancelAdministratorReservations.mockResolvedValue(serviceResult);
  });

  it.each(["preview", "execute"] as const)("returns HTTP 200 partial results for %s mode", async (mode) => {
    // Given
    const body = { mode, reason: "행사 준비", reservationIds: ["reservation-1", "reservation-2"] };

    // When
    const response = await POST(bulkRequest(body));

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(serviceResult);
    expect(routeMocks.bulkCancelAdministratorReservations).toHaveBeenCalledWith({
      actor: { id: adminUser.id, role: "ADMIN" },
      ipHash: expect.any(String),
      ...body,
      source: { kind: "WEB_ADMIN" }
    });
    expect(routeMocks.scheduleDiscordOperationsBoardSync).toHaveBeenCalledTimes(mode === "execute" ? 1 : 0);
  });

  it.each([
    ["duplicate IDs", { mode: "execute", reason: "행사", reservationIds: ["same", "same"] }],
    ["51 IDs", { mode: "execute", reason: "행사", reservationIds: Array.from({ length: 51 }, (_, i) => `id-${i}`) }],
    ["an empty reason", { mode: "execute", reason: " ", reservationIds: ["id-1"] }],
    ["a 201-character reason", { mode: "execute", reason: "가".repeat(201), reservationIds: ["id-1"] }],
    ["an extra no-show field", { mode: "execute", noShow: true, reason: "행사", reservationIds: ["id-1"] }]
  ])("rejects %s at the boundary without calling the service", async (_label, body) => {
    // Given / When
    const response = await POST(bulkRequest(body));

    // Then
    expect(response.status).toBe(400);
    expect(routeMocks.bulkCancelAdministratorReservations).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 unique IDs", async () => {
    // Given
    const reservationIds = Array.from({ length: 50 }, (_, i) => `id-${i}`);

    // When
    const response = await POST(bulkRequest({ mode: "preview", reason: "행사", reservationIds }));

    // Then
    expect(response.status).toBe(200);
    expect(routeMocks.bulkCancelAdministratorReservations).toHaveBeenCalledOnce();
  });

  it("rejects a missing CSRF token before rate limiting or service execution", async () => {
    // Given
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "error", reason: "csrf_missing" });

    // When
    const response = await POST(validRequest());

    // Then
    expect(response.status).toBe(403);
    expect(routeMocks.enforceAdminMutationRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.bulkCancelAdministratorReservations).not.toHaveBeenCalled();
  });

  it("returns the shared rate-limit response before parsing or service execution", async () => {
    // Given
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "blocked",
      limit: 20,
      resetAt: new Date(Date.now() + 30_000)
    });

    // When
    const response = await POST(validRequest());

    // Then
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(routeMocks.bulkCancelAdministratorReservations).not.toHaveBeenCalled();
  });

  it("returns 401 when no administrator session exists", async () => {
    // Given
    const { UnauthorizedSessionError } = await import("@/lib/session");
    routeMocks.requireAdminSession.mockRejectedValue(new UnauthorizedSessionError());

    // When
    const response = await POST(validRequest());

    // Then
    expect(response.status).toBe(401);
    expect(routeMocks.validateRequestCsrf).not.toHaveBeenCalled();
  });
});

function bulkRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/reservations/bulk-cancel", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost", "x-csrf-token": "csrf-token" },
    method: "POST"
  });
}

function validRequest(): Request {
  return bulkRequest({ mode: "execute", reason: "행사 준비", reservationIds: ["reservation-1"] });
}
