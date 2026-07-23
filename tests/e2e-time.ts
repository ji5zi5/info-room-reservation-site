import type { Page } from "@playwright/test";

import { todayKst } from "./kst-date";

export const FIXED_THURSDAY_DATE = "2026-06-11";
export const FIXED_FRIDAY_DATE = "2026-06-12";

export function e2eNow(date = todayKst()): string {
  return `${date}T09:00:00+09:00`;
}

export async function mockClientDate(page: Page, fixedIso = e2eNow()): Promise<void> {
  await page.addInitScript((iso) => {
    const fixedNow = new Date(iso).valueOf();
    const RealDate = Date;
    class MockDate extends RealDate {
      public constructor(value?: string | number | Date) {
        super(value ?? fixedNow);
      }

      public static override now(): number {
        return fixedNow;
      }
    }
    globalThis.Date = MockDate as DateConstructor;
  }, fixedIso);
}

export async function mockOpenPeriodsForDates(page: Page, ...dates: readonly string[]): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    const url = new URL(route.request().url());
    const weekStart = url.searchParams.get("weekStart");
    if (weekStart) {
      await route.fulfill({
        body: JSON.stringify({
          dates: schoolWeekDates(weekStart).map((date) => ({
            date,
            periods: [buildMockWeekPeriod("EIGHTH"), buildMockWeekPeriod("FIRST")]
          }))
        }),
        contentType: "application/json",
        status: 200
      });
      return;
    }
    const date = url.searchParams.get("date");
    if (!date || !dates.includes(date)) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        date,
        periods: [
          buildMockPeriod(date, "EIGHTH", "8면학"),
          buildMockPeriod(date, "FIRST", "1면학")
        ]
      }),
      contentType: "application/json",
      status: 200
    });
  });
}

function schoolWeekDates(weekStart: string): readonly string[] {
  const start = new Date(`${weekStart}T00:00:00.000Z`).valueOf();
  return Array.from({ length: 5 }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10)
  );
}

function buildMockWeekPeriod(studyPeriod: "EIGHTH" | "FIRST"): object {
  return {
    availability: 10,
    capacity: 10,
    closeTime: "23:59",
    enabled: true,
    myReservationId: null,
    openTime: "00:00",
    reservedCount: 0,
    studyPeriod
  };
}

function buildMockPeriod(date: string, studyPeriod: "EIGHTH" | "FIRST", label: string): object {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: 0,
    date,
    enabled: true,
    label,
    myReservationId: null,
    openTime: "00:00",
    remaining: 10,
    studyPeriod,
    windowState: "open"
  };
}
