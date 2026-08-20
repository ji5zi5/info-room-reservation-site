import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actionCreate: vi.fn(),
  auditCreate: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  upsert: vi.fn(),
  withDatabaseMutation: vi.fn()
}));

vi.mock("./db", () => ({ prisma: {} }));
vi.mock("./db-context", () => ({
  withDatabaseMutation: mocks.withDatabaseMutation
}));

import { updateDiscordAdminPeriodSetting } from "./discord-admin-settings-service";

const actor = {
  discordUserId: "12345678901234572",
  id: "admin-1",
  name: "관리자",
  role: "ADMIN" as const,
  studentNumber: "31001"
};
const now = new Date("2026-08-20T05:00:00.000Z");

describe("Discord administrator period settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findMany.mockResolvedValue([]);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.upsert.mockResolvedValue({});
    mocks.actionCreate.mockResolvedValue({ id: "action-1" });
    mocks.auditCreate.mockResolvedValue({});
    mocks.withDatabaseMutation.mockImplementation(({ operation }) => operation({
      adminAction: { create: mocks.actionCreate },
      auditLog: { create: mocks.auditCreate },
      periodSetting: { findMany: mocks.findMany, updateMany: mocks.updateMany, upsert: mocks.upsert }
    }));
  });

  it("applies an all-date field only to future exceptions and the global default", async () => {
    await updateDiscordAdminPeriodSetting({
      actor,
      intent: {
        capacity: 15,
        date: null,
        kind: "setting_capacity",
        reason: "정원 조정",
        scope: "ALL",
        studyPeriod: "EIGHTH"
      },
      ipHash: "a".repeat(64),
      now
    });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      data: { capacity: 15 },
      where: { date: { gt: "2026-08-20" }, studyPeriod: "EIGHTH" }
    });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { date_studyPeriod: { date: "__global__", studyPeriod: "EIGHTH" } }
    }));
    expect(mocks.withDatabaseMutation).toHaveBeenCalledWith(expect.objectContaining({
      lockKeys: ["period-settings:EIGHTH"]
    }));
  });

  it("keeps a date-specific override isolated to that date", async () => {
    await updateDiscordAdminPeriodSetting({
      actor,
      intent: {
        date: "2026-08-24",
        enabled: false,
        kind: "setting_enabled",
        reason: "행사 운영",
        scope: "DATE",
        studyPeriod: "FIRST"
      },
      ipHash: "a".repeat(64),
      now
    });

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { date_studyPeriod: { date: "2026-08-24", studyPeriod: "FIRST" } }
    }));
  });
});
