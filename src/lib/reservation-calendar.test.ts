import { describe, expect, it } from "vitest";

import { buildReservationCalendarDays } from "./reservation-calendar";

const thursdayPolicy = {
  kind: "available",
  maxDate: "2026-06-12",
  minDate: "2026-06-12",
  today: "2026-06-11"
} as const;

describe("reservation calendar", () => {
  it("builds this school week and highlights the advance reservation window", () => {
    const days = buildReservationCalendarDays(thursdayPolicy);

    expect(days.map((day) => day.date)).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12"
    ]);
    expect(days.map((day) => day.dayLabel)).toEqual(["월", "화", "수", "목", "금"]);
    expect(days.map((day) => day.selectable)).toEqual([false, false, false, true, true]);
    expect(days.map((day) => day.isAdvanceWindow)).toEqual([false, false, false, false, true]);
  });
});
