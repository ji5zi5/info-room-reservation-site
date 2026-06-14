import { describe, expect, it } from "vitest";

import { getPeriodWindowState, isPeriodWindowClosed, type PeriodWindowSetting } from "./period-window";

const setting = {
  closeTime: "16:20",
  date: "2026-06-12",
  openTime: "13:00"
} satisfies PeriodWindowSetting;

describe("period KST window state", () => {
  it("shares the open and closed boundary used by reservations and notifications", () => {
    expect(getPeriodWindowState(setting, new Date("2026-06-12T03:59:00.000Z"))).toBe("not_open_yet");
    expect(getPeriodWindowState(setting, new Date("2026-06-12T04:00:00.000Z"))).toBe("open");
    expect(getPeriodWindowState(setting, new Date("2026-06-12T07:20:00.000Z"))).toBe("open");
    expect(getPeriodWindowState(setting, new Date("2026-06-12T07:21:00.000Z"))).toBe("closed");
  });

  it("uses the current KST time window for future reservable dates and closes past dates", () => {
    expect(getPeriodWindowState(setting, new Date("2026-06-11T03:59:00.000Z"))).toBe("not_open_yet");
    expect(getPeriodWindowState(setting, new Date("2026-06-11T04:00:00.000Z"))).toBe("open");
    expect(getPeriodWindowState(setting, new Date("2026-06-11T07:21:00.000Z"))).toBe("closed");
    expect(getPeriodWindowState(setting, new Date("2026-06-13T03:00:00.000Z"))).toBe("closed");
  });

  it("exposes a notification-friendly closed predicate", () => {
    expect(isPeriodWindowClosed(setting, new Date("2026-06-12T07:20:00.000Z"))).toBe(false);
    expect(isPeriodWindowClosed(setting, new Date("2026-06-12T07:21:00.000Z"))).toBe(true);
  });
});
