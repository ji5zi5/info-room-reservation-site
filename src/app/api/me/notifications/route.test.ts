import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/session";

type NotificationsRouteModule = {
  readonly GET: () => Promise<Response>;
};
type RequireUser = () => Promise<SessionUser>;
type IsNoDatabaseMockMode = () => boolean;
type AdminActionFindMany = (query: unknown) => Promise<readonly unknown[]>;
type ExecuteRaw = (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
type MockTransaction = {
  readonly $executeRaw: ExecuteRaw;
  readonly adminAction: {
    readonly findMany: AdminActionFindMany;
  };
};
type DatabaseTransaction = <T>(operation: (transaction: MockTransaction) => Promise<T>, options?: unknown) => Promise<T>;

const routeMocks = vi.hoisted(() => {
  class UnauthorizedSessionError extends Error {
    public constructor() {
      super("Login is required.");
      this.name = "UnauthorizedSessionError";
    }
  }

  return {
    UnauthorizedSessionError,
    adminActionFindMany: vi.fn<AdminActionFindMany>(),
    databaseTransaction: vi.fn<DatabaseTransaction>(),
    executeRaw: vi.fn<ExecuteRaw>(),
    isNoDatabaseMockMode: vi.fn<IsNoDatabaseMockMode>(),
    requireUser: vi.fn<RequireUser>()
  };
});

vi.mock("@/lib/db", () => ({ prisma: { $transaction: routeMocks.databaseTransaction } }));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/session", () => ({
  UnauthorizedSessionError: routeMocks.UnauthorizedSessionError,
  requireUser: routeMocks.requireUser
}));

const studentUser: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "student-session-user",
  name: "Student One",
  restrictionReason: null,
  restrictedUntil: null,
  role: "STUDENT",
  studentNumber: "31001"
};

const adminUser: SessionUser = {
  ...studentUser,
  id: "admin-session-user",
  role: "ADMIN",
  studentNumber: "90000"
};

describe("student notifications route", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    routeMocks.adminActionFindMany.mockResolvedValue([]);
    routeMocks.databaseTransaction.mockImplementation(async (operation) =>
      operation({ $executeRaw: routeMocks.executeRaw, adminAction: { findMany: routeMocks.adminActionFindMany } })
    );
    routeMocks.executeRaw.mockResolvedValue(1);
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.requireUser.mockResolvedValue(studentUser);
  });

  it("returns unauthorized JSON when no student session exists", async () => {
    // Given
    routeMocks.requireUser.mockRejectedValue(new routeMocks.UnauthorizedSessionError());
    const { GET } = await loadNotificationsRoute();

    // When
    const response = await GET();

    // Then
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });
    expect(routeMocks.adminActionFindMany).not.toHaveBeenCalled();
  });

  it("returns forbidden JSON when an admin session requests student notifications", async () => {
    // Given
    routeMocks.requireUser.mockResolvedValue(adminUser);
    const { GET } = await loadNotificationsRoute();

    // When
    const response = await GET();

    // Then
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    expect(routeMocks.adminActionFindMany).not.toHaveBeenCalled();
  });

  it("returns no notifications in no-database mock mode", async () => {
    // Given
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);
    const { GET } = await loadNotificationsRoute();

    // When
    const response = await GET();

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notifications: [] });
    expect(routeMocks.adminActionFindMany).not.toHaveBeenCalled();
  });

  it("loads only the current student's admin cancellation actions", async () => {
    // Given
    routeMocks.adminActionFindMany.mockResolvedValue([
      {
        action: "ADMIN_RESERVATION_CANCEL",
        createdAt: new Date("2026-06-16T04:30:00.000Z"),
        id: "action-cancel",
        reservation: { date: "2026-06-17", studyPeriod: "EIGHTH" }
      }
    ]);
    const { GET } = await loadNotificationsRoute();

    // When
    const response = await GET();

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      notifications: [
        {
          createdAt: "2026-06-16T04:30:00.000Z",
          id: "action-cancel",
          message: "2026-06-17 8면학 신청이 취소되었습니다.",
          title: "관리자 취소 안내"
        }
      ]
    });
    expect(routeMocks.adminActionFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      select: {
        action: true,
        createdAt: true,
        id: true,
        reservation: { select: { date: true, studyPeriod: true } }
      },
      take: 5,
      where: { action: { in: ["ADMIN_RESERVATION_CANCEL"] }, targetUserId: studentUser.id }
    });
  });
});

async function loadNotificationsRoute(): Promise<NotificationsRouteModule> {
  const routeModule: unknown = await import("./route");
  if (!isNotificationsRouteModule(routeModule)) {
    throw new Error("Notifications route module must export GET.");
  }
  return routeModule;
}

function isNotificationsRouteModule(value: unknown): value is NotificationsRouteModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "GET") === "function";
}
