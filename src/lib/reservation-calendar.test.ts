import { describe, expect, it } from "vitest";

import {
  buildReservationCalendarDays,
  summarizeReservationCalendarDay,
  type ReservationCalendarDay,
  type ReservationCalendarPeriod
} from "./reservation-calendar";

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

  it("prioritizes my reservation over availability", () => {
    expect(
      summarizeReservationCalendarDay(selectableDay(), [
        period({ label: "8면학", myReservationId: "reservation-1" }),
        period({ label: "1면학" })
      ])
    ).toMatchObject({
      detail: "8면학 예약됨",
      status: "mine",
      statusLabel: "내 예약"
    });
  });

  it("summarizes available, closed, and unavailable days", () => {
    expect(summarizeReservationCalendarDay(selectableDay(), [period({ windowState: "not_open_yet" })])).toMatchObject({
      detail: "8면학 오픈 전",
      status: "available",
      statusLabel: "예약 가능"
    });
    expect(summarizeReservationCalendarDay(selectableDay(), [period({ remaining: 0 })])).toMatchObject({
      status: "closed",
      statusLabel: "마감"
    });
    expect(summarizeReservationCalendarDay(selectableDay(), [period({ enabled: false })])).toMatchObject({
      status: "unavailable",
      statusLabel: "불가"
    });
  });
});

function selectableDay(): ReservationCalendarDay {
  return {
    date: "2026-06-12",
    dayLabel: "금",
    isAdvanceWindow: true,
    isPast: false,
    isToday: false,
    selectable: true
  };
}

function period(input: Partial<ReservationCalendarPeriod> = {}): ReservationCalendarPeriod {
  return {
    enabled: input.enabled ?? true,
    label: input.label ?? "8면학",
    myReservationId: input.myReservationId ?? null,
    remaining: input.remaining ?? 4,
    windowState: input.windowState ?? "open"
  };
}
