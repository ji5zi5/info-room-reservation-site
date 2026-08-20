import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TransactionRetryExhaustedError } from "@/lib/db-context";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { ReservationResult } from "@/lib/reservation-service";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReserveStudyPeriod = (input: unknown) => Promise<ReservationResult>;
type RequireSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;

const nextServerMocks = vi.hoisted(
  (): { capturedAfter: (() => void | Promise<void>) | undefined } => ({ capturedAfter: undefined })
);

const routeMocks = vi.hoisted(() => ({
  createPrismaReservationStoreForActor: vi.fn(),
  enforceReservationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  isReservableDate: vi.fn<() => boolean>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  requireSession: vi.fn<RequireSession>(),
  reserveMockStudyPeriod: vi.fn(),
  reserveStudyPeriod: vi.fn<ReserveStudyPeriod>(),
  runDiscordReservationOutbox: vi.fn(),
  syncDiscordOperationsBoardAfterMutation: vi.fn(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/advance-reservation-policy", () => ({
  isReservableDate: routeMocks.isReservableDate
}));

vi.mock("@/lib/prisma-reservation-store", () => ({
  createPrismaReservationStoreForActor: routeMocks.createPrismaReservationStoreForActor
}));

vi.mock("@/lib/reservation-service", () => ({
  reserveStudyPeriod: routeMocks.reserveStudyPeriod
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-reservation-data", () => ({
  reserveMockStudyPeriod: routeMocks.reserveMockStudyPeriod
}));

vi.mock("@/lib/discord-reservation-outbox", () => ({
  runDiscordReservationOutbox: routeMocks.runDiscordReservationOutbox
}));

vi.mock("@/lib/discord-operations-board-after-mutation", () => ({
  syncDiscordOperationsBoardAfterMutation: routeMocks.syncDiscordOperationsBoardAfterMutation
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
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {},
  requireSession: routeMocks.requireSession
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((callback: () => void | Promise<void>) => {
    nextServerMocks.capturedAfter = callback;
  })
}));

import { POST } from "./route";

const studentUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "student-1",
  name: "엄지오",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "31001"
};

const confirmedReservation = {
  date: "2026-07-01",
  id: "reservation-1",
  reason: "과제",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: studentUser.id
} as const;

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-30T00:01:00.000Z")
};

describe("reservation create route Discord notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextServerMocks.capturedAfter = undefined;
    vi.stubEnv("APP_ORIGIN", "https://example.test");
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/1/token");
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireSession.mockResolvedValue({ id: "session-student", user: studentUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceReservationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isReservableDate.mockReturnValue(true);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.createPrismaReservationStoreForActor.mockReturnValue({});
    routeMocks.reserveStudyPeriod.mockResolvedValue({ kind: "confirmed", reservation: confirmedReservation });
    routeMocks.reserveMockStudyPeriod.mockReturnValue({ kind: "confirmed", reservation: confirmedReservation });
    routeMocks.runDiscordReservationOutbox.mockResolvedValue({ initial: {}, sync: {} });
    routeMocks.syncDiscordOperationsBoardAfterMutation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 201 before the deferred successful notification callback runs", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(reservationRequest());

    expect(response.status).toBe(201);
    expect(routeMocks.runDiscordReservationOutbox).not.toHaveBeenCalled();
    expect(nextServerMocks.capturedAfter).toEqual(expect.any(Function));
    expect(errorLog).not.toHaveBeenCalled();

    await nextServerMocks.capturedAfter?.();

    expect(routeMocks.runDiscordReservationOutbox).toHaveBeenCalledWith({
      now: expect.any(Date),
      reservationId: confirmedReservation.id
    });
    expect(routeMocks.syncDiscordOperationsBoardAfterMutation).toHaveBeenCalledOnce();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("logs an unexpected deferred notification failure only after returning 201", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.runDiscordReservationOutbox.mockRejectedValue(new Error("discord down"));

    const response = await POST(reservationRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ reservation: confirmedReservation });
    expect(routeMocks.runDiscordReservationOutbox).not.toHaveBeenCalled();
    expect(nextServerMocks.capturedAfter).toEqual(expect.any(Function));
    expect(errorLog).not.toHaveBeenCalled();

    await nextServerMocks.capturedAfter?.();

    expect(errorLog).toHaveBeenCalledTimes(1);
    expectStructuredOutboxFailure(errorLog.mock.calls[0]?.[0]);
  });

  it("does not send Discord notifications in no-database mock mode", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const response = await POST(reservationRequest());

    expect(response.status).toBe(201);
    expect(routeMocks.runDiscordReservationOutbox).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when reservation serialization is exhausted", async () => {
    routeMocks.reserveStudyPeriod.mockRejectedValue(new TransactionRetryExhaustedError(new Error("P2034")));

    const response = await POST(reservationRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "transaction_retry_exhausted",
        message: "동시 요청이 많습니다. 잠시 후 다시 시도해주세요."
      }
    });
    expect(routeMocks.runDiscordReservationOutbox).not.toHaveBeenCalled();
  });

  it("returns one deterministic generic denial for a shadow-banned reservation", async () => {
    const randomSpy = vi.spyOn(Math, "random");
    routeMocks.reserveStudyPeriod.mockResolvedValue({ kind: "error", reason: "shadow_banned" });

    const response = await POST(reservationRequest());

    expect(response.status).toBe(403);
    expect(response.headers.get("X-Reservation-Error-Surface")).toBeNull();
    expect(response.headers.get("X-Reservation-Error-Status")).toBeNull();
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: { code: "reservation_unavailable", message: "예약을 처리할 수 없습니다." }
    });
    expect(routeMocks.reserveStudyPeriod).toHaveBeenCalledTimes(1);
    expect(randomSpy).not.toHaveBeenCalled();
    expect(routeMocks.runDiscordReservationOutbox).not.toHaveBeenCalled();
  });

  it("uses the same generic denial in no-database mock mode", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    routeMocks.reserveMockStudyPeriod.mockReturnValue({ kind: "error", reason: "shadow_banned" });

    const response = await POST(reservationRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "reservation_unavailable", message: "예약을 처리할 수 없습니다." }
    });
    expect(routeMocks.reserveStudyPeriod).not.toHaveBeenCalled();
    expect(routeMocks.runDiscordReservationOutbox).not.toHaveBeenCalled();
  });
});

function reservationRequest(): Request {
  return new Request("https://example.test/api/reservations", {
    body: JSON.stringify({
      date: confirmedReservation.date,
      reason: confirmedReservation.reason,
      studyPeriod: confirmedReservation.studyPeriod
    }),
    headers: {
      "content-type": "application/json",
      forwarded: "host=spoofed.example;proto=https",
      host: "spoofed.example",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "POST"
  });
}

function expectStructuredOutboxFailure(value: unknown): void {
  expect(typeof value).toBe("string");
  const serialized = String(value);
  expect(JSON.parse(serialized)).toEqual({
    event: "discord_reservation_outbox_trigger_failed",
    reservationId: confirmedReservation.id
  });
  expect(serialized).not.toContain(confirmedReservation.reason);
  expect(serialized).not.toContain(confirmedReservation.userId);
  expect(serialized).not.toContain("discord down");
  expect(serialized).not.toContain("/api/webhooks/");
}
