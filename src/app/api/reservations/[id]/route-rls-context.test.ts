import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseActor } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { Reservation } from "@/lib/reservation-service";
import type { CurrentSession, SessionUser } from "@/lib/session";

type WriteMutation = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $queryRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<readonly { readonly outcome: string }[]>;
  readonly adminAction: { readonly create: WriteMutation };
  readonly auditLog: { readonly create: WriteMutation };
  readonly reservation: {
    readonly findUnique: (input: unknown) => Promise<Reservation | null>;
    readonly updateMany: WriteMutation;
  };
  readonly user: { readonly update: WriteMutation };
  readonly userSanction: { readonly create: WriteMutation; readonly updateMany: WriteMutation };
};

const routeMocks = vi.hoisted(() => {
  class TransactionRetryExhaustedError extends Error {}
  class UnauthorizedSessionError extends Error {}

  return {
    TransactionRetryExhaustedError,
    UnauthorizedSessionError,
    actor: vi.fn<(actor: DatabaseActor) => void>(),
    adminActionCreate: vi.fn<WriteMutation>(),
    auditLogCreate: vi.fn<WriteMutation>(),
    cancellationCapability: vi.fn<
      (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<readonly { readonly outcome: string }[]>
    >(),
    reservationFindUnique: vi.fn<(input: unknown) => Promise<Reservation | null>>(),
    reservationUpdateMany: vi.fn<WriteMutation>(),
    requireSession: vi.fn<() => Promise<CurrentSession>>(),
    userSanctionCreate: vi.fn<WriteMutation>(),
    userSanctionUpdateMany: vi.fn<WriteMutation>(),
    userUpdate: vi.fn<WriteMutation>()
  };
});

vi.mock("@/lib/db", () => ({ prisma: {} }));

vi.mock("@/lib/db-context", () => ({
  TransactionRetryExhaustedError: routeMocks.TransactionRetryExhaustedError,
  databaseActorFromSessionUser: (user: SessionUser): DatabaseActor => ({ id: user.id, role: "STUDENT" }),
  systemDatabaseActor: (): DatabaseActor => ({ id: null, role: "SYSTEM" }),
  userMutationLockKey: (userId: string): string => `user:${userId}`,
  withDatabaseMutation: async (input: {
    readonly actor: DatabaseActor;
    readonly operation: (transaction: TransactionClient) => Promise<unknown>;
  }): Promise<unknown> => {
    routeMocks.actor(input.actor);
    return input.operation(transactionClient());
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({ isNoDatabaseMockMode: () => false }));
vi.mock("@/lib/mock-reservation-data", () => ({ cancelMockReservation: vi.fn() }));
vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string): string => reason,
  validateRequestCsrf: async (): Promise<{ readonly kind: "ok" }> => ({ kind: "ok" })
}));
vi.mock("@/lib/request-security", () => ({ requireMutatingRequestSafety: () => null }));
vi.mock("@/lib/route-rate-limit", () => ({
  enforceReservationRateLimit: async (): Promise<RateLimitResult> => ({
    kind: "allowed",
    remaining: 9,
    resetAt: new Date("2026-08-10T00:00:00.000Z")
  })
}));
vi.mock("@/lib/session", () => ({
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  createMockSessionToken: vi.fn(),
  requireSession: routeMocks.requireSession,
  setSessionCookie: vi.fn()
}));

const student: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 32,
  id: "student-owner",
  name: "Owner",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "32001"
};

const reservation: Reservation = {
  date: "2026-08-11",
  id: "reservation-owned",
  reason: "study",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: student.id
};

describe("student cancellation PostgreSQL RLS context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    routeMocks.requireSession.mockResolvedValue({ id: "session-owner", user: student });
    routeMocks.reservationFindUnique.mockResolvedValue(reservation);
    routeMocks.cancellationCapability.mockResolvedValue([{ outcome: "CANCELLED" }]);
    routeMocks.userUpdate.mockResolvedValue({ ...student, bookingStatus: "RESTRICTED", restrictionReason: "cancelled" });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-cancel" });
  });

  it("uses the authenticated STUDENT Given an owned reservation When the cancellation transaction starts Then protected writes stay actor-bound", async () => {
    // Given
    const { DELETE } = await import("./route");

    // When
    const response = await DELETE(deleteRequest(), routeContext(reservation.id));

    // Then
    expect(response.status).toBe(200);
    expect(routeMocks.actor).toHaveBeenCalledWith({ id: student.id, role: "STUDENT" });
  });

  it("returns 403 Given another student's reservation When cancellation is requested Then no reservation, user, sanction, or audit write runs", async () => {
    // Given
    routeMocks.cancellationCapability.mockResolvedValue([{ outcome: "FORBIDDEN" }]);
    const { DELETE } = await import("./route");

    // When
    const response = await DELETE(deleteRequest(), routeContext(reservation.id));

    // Then
    expect(response.status).toBe(403);
    expect(routeMocks.reservationUpdateMany).not.toHaveBeenCalled();
    expect(routeMocks.userUpdate).not.toHaveBeenCalled();
    expect(routeMocks.adminActionCreate).not.toHaveBeenCalled();
    expect(routeMocks.userSanctionUpdateMany).not.toHaveBeenCalled();
    expect(routeMocks.userSanctionCreate).not.toHaveBeenCalled();
    expect(routeMocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("returns 404 Given an unknown reservation When cancellation is requested Then no reservation payload is exposed", async () => {
    // Given
    routeMocks.cancellationCapability.mockResolvedValue([{ outcome: "NOT_FOUND" }]);
    const { DELETE } = await import("./route");

    // When
    const response = await DELETE(deleteRequest(), routeContext("reservation-missing"));

    // Then
    expect(response.status).toBe(404);
    expect(routeMocks.reservationFindUnique).not.toHaveBeenCalled();
  });

  it("returns 409 Given a non-confirmed reservation When cancellation is requested Then no cancelled reservation is returned", async () => {
    // Given
    routeMocks.cancellationCapability.mockResolvedValue([{ outcome: "NOT_CANCELLABLE" }]);
    const { DELETE } = await import("./route");

    // When
    const response = await DELETE(deleteRequest(), routeContext(reservation.id));

    // Then
    expect(response.status).toBe(409);
    expect(routeMocks.reservationFindUnique).not.toHaveBeenCalled();
  });
});

function transactionClient(): TransactionClient {
  return {
    $queryRaw: routeMocks.cancellationCapability,
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    reservation: { findUnique: routeMocks.reservationFindUnique, updateMany: routeMocks.reservationUpdateMany },
    user: { update: routeMocks.userUpdate },
    userSanction: { create: routeMocks.userSanctionCreate, updateMany: routeMocks.userSanctionUpdateMany }
  };
}

function deleteRequest(): Request {
  return new Request(`https://example.test/api/reservations/${reservation.id}`, {
    headers: { "x-csrf-token": "csrf-token", origin: "https://example.test" },
    method: "DELETE"
  });
}

function routeContext(id: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id }) };
}
