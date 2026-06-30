import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { ReservationResult } from "@/lib/reservation-service";
import type { CurrentSession, SessionUser } from "@/lib/session";

type ReserveStudyPeriod = (input: unknown) => Promise<ReservationResult>;
type RequireSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;

const routeMocks = vi.hoisted(() => ({
  createPrismaReservationStoreForActor: vi.fn(),
  enforceReservationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  getPrismaNotificationSettings: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  isReservableDate: vi.fn<() => boolean>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  requireSession: vi.fn<RequireSession>(),
  reserveMockStudyPeriod: vi.fn(),
  reserveStudyPeriod: vi.fn<ReserveStudyPeriod>(),
  sendDiscordWebhook: vi.fn(),
  sendReservationCreatedNotification: vi.fn(),
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

vi.mock("@/lib/prisma-notification-settings", () => ({
  getPrismaNotificationSettings: routeMocks.getPrismaNotificationSettings
}));

vi.mock("@/lib/reservation-created-notification-service", () => ({
  sendReservationCreatedNotification: routeMocks.sendReservationCreatedNotification
}));

vi.mock("@/lib/discord-notifications", () => ({
  sendDiscordWebhook: routeMocks.sendDiscordWebhook
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
    vi.resetAllMocks();
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
    routeMocks.getPrismaNotificationSettings.mockResolvedValue({
      closedPeriodNotificationsEnabled: true,
      id: "global",
      reservationCreatedNotificationsEnabled: true
    });
    routeMocks.sendReservationCreatedNotification.mockResolvedValue({ kind: "sent", messageIds: ["discord-1"] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a best-effort reservation-created notification after a confirmed database reservation", async () => {
    const response = await POST(reservationRequest());

    expect(response.status).toBe(201);
    expect(routeMocks.sendReservationCreatedNotification).toHaveBeenCalledWith({
      notificationSettings: {
        closedPeriodNotificationsEnabled: true,
        id: "global",
        reservationCreatedNotificationsEnabled: true
      },
      reservation: confirmedReservation,
      sender: expect.any(Function),
      user: { name: studentUser.name, studentNumber: studentUser.studentNumber },
      webhookUrl: "https://discord.com/api/webhooks/1/token"
    });
  });

  it("keeps the reservation response successful when the Discord notification sender fails", async () => {
    routeMocks.sendReservationCreatedNotification.mockRejectedValue(new Error("discord down"));

    const response = await POST(reservationRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ reservation: confirmedReservation });
  });

  it("does not send Discord notifications in no-database mock mode", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const response = await POST(reservationRequest());

    expect(response.status).toBe(201);
    expect(routeMocks.getPrismaNotificationSettings).not.toHaveBeenCalled();
    expect(routeMocks.sendReservationCreatedNotification).not.toHaveBeenCalled();
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
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "POST"
  });
}
