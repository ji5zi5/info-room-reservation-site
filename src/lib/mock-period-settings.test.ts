import { afterEach, describe, expect, it } from "vitest";

import {
  getMockAdminPeriodSettings,
  resetMockAdminPeriodSettingsForTests,
  updateMockAdminPeriodSettings,
  type MockAdminPeriodSettingInput
} from "./mock-period-settings";

describe("mock admin period settings", () => {
  afterEach(() => {
    resetMockAdminPeriodSettingsForTests();
  });

  it("returns default period settings in study-period order", () => {
    const periods = getMockAdminPeriodSettings("2026-06-14", new Date("2026-06-13T23:00:00.000Z"));

    expect(periods.map((period) => period.studyPeriod)).toEqual(["EIGHTH", "FIRST"]);
    expect(
      periods.map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        confirmedCount: period.confirmedCount,
        enabled: period.enabled,
        openTime: period.openTime,
        remaining: period.remaining,
        windowState: period.windowState
      }))
    ).toEqual([
      {
        capacity: 10,
        closeTime: "16:20",
        confirmedCount: 0,
        enabled: true,
        openTime: "13:00",
        remaining: 10,
        windowState: "not_open_yet"
      },
      {
        capacity: 10,
        closeTime: "16:20",
        confirmedCount: 0,
        enabled: true,
        openTime: "13:00",
        remaining: 10,
        windowState: "not_open_yet"
      }
    ]);
  });

  it("persists saved settings for the requested date", () => {
    const updates = [
      {
        capacity: 7,
        closeTime: "09:00",
        enabled: true,
        openTime: "08:00",
        studyPeriod: "FIRST"
      },
      {
        capacity: 4,
        closeTime: "10:00",
        enabled: false,
        openTime: "09:00",
        studyPeriod: "EIGHTH"
      }
    ] satisfies readonly MockAdminPeriodSettingInput[];

    updateMockAdminPeriodSettings("2026-06-14", updates, new Date("2026-06-14T00:30:00.000Z"));

    expect(
      getMockAdminPeriodSettings("2026-06-14", new Date("2026-06-14T00:30:00.000Z")).map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        enabled: period.enabled,
        openTime: period.openTime,
        remaining: period.remaining,
        studyPeriod: period.studyPeriod,
        windowState: period.windowState
      }))
    ).toEqual([
      {
        capacity: 4,
        closeTime: "10:00",
        enabled: false,
        openTime: "09:00",
        remaining: 4,
        studyPeriod: "EIGHTH",
        windowState: "open"
      },
      {
        capacity: 7,
        closeTime: "09:00",
        enabled: true,
        openTime: "08:00",
        remaining: 7,
        studyPeriod: "FIRST",
        windowState: "closed"
      }
    ]);
  });
});
