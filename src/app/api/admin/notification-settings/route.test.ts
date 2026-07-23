import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type NotificationSettingRow = {
  readonly closedPeriodNotificationsEnabled: boolean;
  readonly id: string;
  readonly reservationCreatedNotificationsEnabled: boolean;
};
type NotificationSettingFindUnique = (input: unknown) => Promise<NotificationSettingRow | null>;
type NotificationSettingUpsert = (input: unknown) => Promise<NotificationSettingRow>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
  readonly notificationSetting: {
    readonly findUnique: NotificationSettingFindUnique;
    readonly upsert: NotificationSettingUpsert;
  };
};
type PrismaTransaction = <T>(operation: (transaction: TransactionClient) => Promise<T>) => Promise<T>;
type RequireAdmin = () => Promise<SessionUser>;
type RequireAdminSession = () => Promise<CurrentSession>;
type ValidateRequestCsrf = (request: Request, sessionId: string) => Promise<{ readonly kind: "ok" }>;

const routeMocks = vi.hoisted(() => ({
  adminActionCreate: vi.fn<AdminActionCreate>(),
  auditLogCreate: vi.fn<AuditLogCreate>(),
  enforceAdminMutationRateLimit: vi.fn<(request: Request, userId: string) => Promise<RateLimitResult>>(),
  getMockNotificationSettings: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  notificationSettingFindUnique: vi.fn<NotificationSettingFindUnique>(),
  notificationSettingUpsert: vi.fn<NotificationSettingUpsert>(),
  requireAdmin: vi.fn<RequireAdmin>(),
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  transaction: vi.fn<PrismaTransaction>(),
  updateMockNotificationSettings: vi.fn(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/mock-notification-settings", () => ({
  getMockNotificationSettings: routeMocks.getMockNotificationSettings,
  updateMockNotificationSettings: routeMocks.updateMockNotificationSettings
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
  requireAdmin: routeMocks.requireAdmin,
  requireAdminSession: routeMocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { GET, PATCH } from "./route";

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

const allowedRateLimit: RateLimitResult = {
  kind: "allowed",
  remaining: 9,
  resetAt: new Date("2026-06-16T00:01:00.000Z")
};

describe("admin notification settings route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.notificationSettingFindUnique.mockResolvedValue({
      closedPeriodNotificationsEnabled: true,
      id: "global",
      reservationCreatedNotificationsEnabled: false
    });
    routeMocks.notificationSettingUpsert.mockResolvedValue({
      closedPeriodNotificationsEnabled: false,
      id: "global",
      reservationCreatedNotificationsEnabled: true
    });
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-1" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.getMockNotificationSettings.mockReturnValue({
      closedPeriodNotificationsEnabled: true,
      id: "global",
      reservationCreatedNotificationsEnabled: false
    });
    routeMocks.updateMockNotificationSettings.mockReturnValue({
      closedPeriodNotificationsEnabled: false,
      id: "global",
      reservationCreatedNotificationsEnabled: true
    });
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("loads global Discord notification settings", async () => {
    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      notificationSettings: {
        closedPeriodNotificationsEnabled: true,
        id: "global",
        reservationCreatedNotificationsEnabled: false
      }
    });
  });

  it("updates settings and writes an audited admin action", async () => {
    const response = await PATCH(notificationSettingsRequest(validSettings()));

    expect(response.status).toBe(200);
    expect(routeMocks.notificationSettingUpsert).toHaveBeenCalledWith({
      create: {
        closedPeriodNotificationsEnabled: false,
        id: "global",
        reservationCreatedNotificationsEnabled: true
      },
      update: {
        closedPeriodNotificationsEnabled: false,
        reservationCreatedNotificationsEnabled: true
      },
      where: { id: "global" }
    });
    expect(routeMocks.adminActionCreate).toHaveBeenCalledWith({
      data: {
        action: "NOTIFICATION_SETTINGS_PATCH",
        actorId: adminUser.id,
        after: JSON.stringify({
          closedPeriodNotificationsEnabled: false,
          reservationCreatedNotificationsEnabled: true
        }),
        before: JSON.stringify({
          closedPeriodNotificationsEnabled: true,
          reservationCreatedNotificationsEnabled: false
        }),
        ipHash: expect.any(String),
        reason: "알림 설정 변경"
      }
    });
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "NOTIFICATION_SETTINGS_PATCH",
        actorId: adminUser.id,
        detail: JSON.stringify({ actionId: "action-1" })
      }
    });
  });

  it("rejects malformed settings before mutating", async () => {
    const response = await PATCH(notificationSettingsRequest({ closedPeriodNotificationsEnabled: "nope" }));

    expect(response.status).toBe(400);
    expect(routeMocks.notificationSettingUpsert).not.toHaveBeenCalled();
  });

  it("rejects removed shadow-ban probability settings", async () => {
    const response = await PATCH(
      notificationSettingsRequest({
        ...validSettings(),
        shadowBanSuccessRate: 0.02
      })
    );

    expect(response.status).toBe(400);
    expect(routeMocks.notificationSettingUpsert).not.toHaveBeenCalled();
  });

  it("uses the mock store without writing audit rows in no-database mock mode", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const response = await PATCH(notificationSettingsRequest(validSettings()));

    expect(response.status).toBe(200);
    expect(routeMocks.updateMockNotificationSettings).toHaveBeenCalledWith(validSettings());
    expect(routeMocks.transaction).not.toHaveBeenCalled();
  });
});

function transactionClient(): TransactionClient {
  return {
    $executeRaw: vi.fn(async () => undefined),
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    notificationSetting: {
      findUnique: routeMocks.notificationSettingFindUnique,
      upsert: routeMocks.notificationSettingUpsert
    }
  };
}

function validSettings(): {
  readonly closedPeriodNotificationsEnabled: boolean;
  readonly reservationCreatedNotificationsEnabled: boolean;
} {
  return {
    closedPeriodNotificationsEnabled: false,
    reservationCreatedNotificationsEnabled: true
  };
}

function notificationSettingsRequest(notificationSettings: unknown): Request {
  return new Request("https://example.test/api/admin/notification-settings", {
    body: JSON.stringify({ notificationSettings }),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "PATCH"
  });
}
