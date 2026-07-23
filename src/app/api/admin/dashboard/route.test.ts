import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(),
  getMockAdminDashboard: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/admin-dashboard", () => ({
  getAdminDashboard: routeMocks.getAdminDashboard
}));

vi.mock("@/lib/mock-admin-data", () => ({
  getMockAdminDashboard: routeMocks.getMockAdminDashboard
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: routeMocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdmin: routeMocks.requireAdmin,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { GET } from "./route";

describe("admin dashboard route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    routeMocks.requireAdmin.mockResolvedValue({});
    routeMocks.getMockAdminDashboard.mockReturnValue([period]);
  });

  it("returns an empty reconciliation backlog in no-database mock mode", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(true);

    const response = await GET(new Request("http://localhost/api/admin/dashboard?date=2026-06-12"));

    await expect(response.json()).resolves.toEqual({
      notificationBacklog: [],
      periods: [period]
    });
  });

  it("returns the database dashboard payload without nesting it under periods", async () => {
    routeMocks.isNoDatabaseMockMode.mockReturnValue(false);
    routeMocks.getAdminDashboard.mockResolvedValue({
      notificationBacklog: [backlogItem],
      periods: [period]
    });

    const response = await GET(new Request("http://localhost/api/admin/dashboard?date=2026-06-12"));

    await expect(response.json()).resolves.toEqual({
      notificationBacklog: [backlogItem],
      periods: [period]
    });
  });
});

const period = {
  applicants: [],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 3,
  date: "2026-06-12",
  enabled: true,
  isClosed: true,
  label: "8면학",
  notification: null,
  openTime: "13:00",
  remaining: 7,
  studyPeriod: "EIGHTH",
  windowState: "closed"
};

const backlogItem = {
  attempts: 1,
  date: "2026-06-12",
  failureCode: "discord_timeout",
  lastError: "Discord response timed out",
  nextAttemptAt: null,
  status: "UNKNOWN",
  studyPeriod: "EIGHTH",
  updatedAt: "2026-06-12T07:25:00.000Z"
};
