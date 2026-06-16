import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";
import type { StudyPeriod } from "@/lib/study-periods";
import { GLOBAL_PERIOD_SETTINGS_DATE } from "@/lib/period-setting-values";

type PeriodPatchRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};
type PeriodSettingFindMany = (input: unknown) => Promise<readonly PeriodPatchRow[]>;
type PeriodSettingUpdateMany = (input: unknown) => Promise<{ readonly count: number }>;
type PeriodSettingUpsert = (input: unknown) => Promise<unknown>;
type AdminActionCreate = (input: unknown) => Promise<{ readonly id: string }>;
type AuditLogCreate = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly adminAction: { readonly create: AdminActionCreate };
  readonly auditLog: { readonly create: AuditLogCreate };
  readonly periodSetting: {
    readonly findMany: PeriodSettingFindMany;
    readonly updateMany: PeriodSettingUpdateMany;
    readonly upsert: PeriodSettingUpsert;
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
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  periodSettingFindMany: vi.fn<PeriodSettingFindMany>(),
  periodSettingUpdateMany: vi.fn<PeriodSettingUpdateMany>(),
  periodSettingUpsert: vi.fn<PeriodSettingUpsert>(),
  requireAdmin: vi.fn<RequireAdmin>(),
  requireAdminSession: vi.fn<RequireAdminSession>(),
  requireMutatingRequestSafety: vi.fn<(request: Request) => null>(),
  reservationGroupBy: vi.fn<() => Promise<readonly unknown[]>>(),
  summaryPeriodSettingFindMany: vi.fn<PeriodSettingFindMany>(),
  transaction: vi.fn<PrismaTransaction>(),
  validateRequestCsrf: vi.fn<ValidateRequestCsrf>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: routeMocks.transaction,
    periodSetting: {
      findMany: routeMocks.summaryPeriodSettingFindMany
    },
    reservation: {
      groupBy: routeMocks.reservationGroupBy
    }
  }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
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

import { PATCH } from "./route";

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

describe("admin period settings route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireMutatingRequestSafety.mockReturnValue(null);
    routeMocks.requireAdmin.mockResolvedValue(adminUser);
    routeMocks.requireAdminSession.mockResolvedValue({ id: "session-admin", user: adminUser });
    routeMocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    routeMocks.enforceAdminMutationRateLimit.mockResolvedValue(allowedRateLimit);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.periodSettingFindMany.mockResolvedValue([
      periodRow({ date: GLOBAL_PERIOD_SETTINGS_DATE, studyPeriod: "EIGHTH" }),
      periodRow({ date: GLOBAL_PERIOD_SETTINGS_DATE, studyPeriod: "FIRST" })
    ]);
    routeMocks.periodSettingUpdateMany.mockResolvedValue({ count: 3 });
    routeMocks.periodSettingUpsert.mockResolvedValue({});
    routeMocks.adminActionCreate.mockResolvedValue({ id: "action-1" });
    routeMocks.auditLogCreate.mockResolvedValue({});
    routeMocks.summaryPeriodSettingFindMany.mockResolvedValue([]);
    routeMocks.reservationGroupBy.mockResolvedValue([]);
    routeMocks.transaction.mockImplementation(async (operation) => operation(transactionClient()));
  });

  it("updates existing settings for every date and stores a global default for future dates", async () => {
    const response = await PATCH(periodPatchRequest());

    expect(response.status).toBe(200);
    expect(routeMocks.periodSettingFindMany).toHaveBeenCalledWith({
      select: {
        capacity: true,
        closeTime: true,
        date: true,
        enabled: true,
        openTime: true,
        studyPeriod: true
      },
      where: { date: { in: ["2026-06-16", GLOBAL_PERIOD_SETTINGS_DATE] } }
    });
    expect(routeMocks.periodSettingUpdateMany).toHaveBeenCalledTimes(2);
    expect(routeMocks.periodSettingUpdateMany).toHaveBeenNthCalledWith(1, {
      data: { capacity: 12, closeTime: "21:30", enabled: true, openTime: "08:00" },
      where: { studyPeriod: "EIGHTH" }
    });
    expect(routeMocks.periodSettingUpdateMany).toHaveBeenNthCalledWith(2, {
      data: { capacity: 9, closeTime: "20:30", enabled: false, openTime: "09:00" },
      where: { studyPeriod: "FIRST" }
    });
    expect(routeMocks.periodSettingUpsert).toHaveBeenNthCalledWith(1, {
      create: {
        capacity: 12,
        closeTime: "21:30",
        date: GLOBAL_PERIOD_SETTINGS_DATE,
        enabled: true,
        openTime: "08:00",
        studyPeriod: "EIGHTH"
      },
      update: { capacity: 12, closeTime: "21:30", enabled: true, openTime: "08:00" },
      where: { date_studyPeriod: { date: GLOBAL_PERIOD_SETTINGS_DATE, studyPeriod: "EIGHTH" } }
    });
    expect(routeMocks.auditLogCreate).toHaveBeenCalledWith({
      data: {
        action: "PERIOD_SETTINGS_PATCH",
        actorId: adminUser.id,
        detail: JSON.stringify({ actionId: "action-1", date: "2026-06-16", periods: 2, scope: "ALL_DATES" })
      }
    });
  });
});

function transactionClient(): TransactionClient {
  return {
    adminAction: { create: routeMocks.adminActionCreate },
    auditLog: { create: routeMocks.auditLogCreate },
    periodSetting: {
      findMany: routeMocks.periodSettingFindMany,
      updateMany: routeMocks.periodSettingUpdateMany,
      upsert: routeMocks.periodSettingUpsert
    }
  };
}

function periodPatchRequest(): Request {
  return new Request("https://example.test/api/admin/period-settings", {
    body: JSON.stringify({
      date: "2026-06-16",
      periods: [
        { capacity: 12, closeTime: "21:30", enabled: true, openTime: "08:00", studyPeriod: "EIGHTH" },
        { capacity: 9, closeTime: "20:30", enabled: false, openTime: "09:00", studyPeriod: "FIRST" }
      ]
    }),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf-token",
      origin: "https://example.test"
    },
    method: "PATCH"
  });
}

function periodRow(input: { readonly date: string; readonly studyPeriod: StudyPeriod }): PeriodPatchRow {
  return {
    capacity: 10,
    closeTime: "16:20",
    date: input.date,
    enabled: true,
    openTime: "13:00",
    studyPeriod: input.studyPeriod
  };
}
