import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MockCancelResult } from "@/lib/mock-reservation-state";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { Reservation } from "@/lib/reservation-service";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReservationFindUnique = (input: unknown) => Promise<Reservation | null>;
type ReservationUpdate = (input: unknown) => Promise<Reservation>;
type UserUpdate = (input: unknown) => Promise<unknown>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type WriteMutation = (input: unknown) => Promise<unknown>;
type CancellationCapability = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => Promise<readonly { readonly outcome: string }[]>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly $queryRaw: CancellationCapability;
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
      super("login required");
      this.name = "UnauthorizedSessionError";
    }
  }

  return {
    UnauthorizedSessionError,
    adminActionCreate: vi.fn<AdminActionCreate>(),
    auditLogCreate: vi.fn<WriteMutation>(),
    cancellationCapability: vi.fn<CancellationCapability>(),
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

const allowedRateLimit: RateLimitResult = { kind: "allowed", remaining: 9, resetAt: new Date("2026-06-17T00:00:00.000Z") };

const student: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 32,
  id: "student-no-show",
  name: "No Show Student",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "32001"
};

const noShowReservation: Reservation = {
  date: "2026-06-17",
  id: "reservation-no-show",
  reason: "study",
  status: "NO_SHOW",
  studyPeriod: "EIGHTH",
  userId: student.id
};

describe("student reservation cancellation status guard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();

    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireSession.mockResolvedValue({ id: "session-no-show", user: student });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceReservationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.cancellationCapability.mockResolvedValue([{ outcome: "NOT_CANCELLABLE" }]);
    routeMocks.reservationFindUnique.mockResolvedValue(noShowReservation);
    routeMocks.reservationUpdate.mockResolvedValue({ ...noShowReservation, status: "CANCELLED" });
    routeMocks.userUpdate.mockResolvedValue({
      ...student,
      bookingStatus: "RESTRICTED",
      restrictedUntil: new Date("2026-06-20T00:00:00.000Z"),
      restrictionReason: "cancelled reservation"
    });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-cancel" });
    routeMocks.userSanctionCreate.mockResolvedValue({});
    routeMocks.userSanctionUpdateMany.mockResolvedValue({});
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("returns conflict Given a no-show reservation When cancellation is requested Then no cancellation payload is returned", async () => {
    // Given
    const { DELETE } = await loadCancelRoute();

    // When
    const response = await DELETE(deleteRequest(), routeContext(noShowReservation.id));

    // Then
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "bad_request" } });
    expect(body).not.toHaveProperty("reservation");
    expect(routeMocks.cancellationCapability).toHaveBeenCalledTimes(1);
    expect(routeMocks.cancellationCapability.mock.calls[0]?.[1]).toBe(noShowReservation.id);
  });
});

function transactionClient(): TransactionClient {
  return {
    async $executeRaw(): Promise<number> {
      return 1;
    },
    $queryRaw: routeMocks.cancellationCapability,
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
  return new Request("https://example.test/api/reservations/reservation-no-show", {
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
