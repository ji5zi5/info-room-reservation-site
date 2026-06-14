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
  for (const date of dates) {
    await page.route(`**/api/periods?date=${date}`, async (route) => {
      await route.fulfill({
        body: JSON.stringify({
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
