import { describe, expect, it } from "vitest";

import { isAllowedPeriodQueryDate } from "./period-query-policy";

describe("period query policy", () => {
  it("allows today and this week's advance reservation window only", () => {
    const now = new Date("2026-06-11T09:00:00+09:00");

    expect(isAllowedPeriodQueryDate("2026-06-11", now)).toBe(true);
    expect(isAllowedPeriodQueryDate("2026-06-12", now)).toBe(true);
    expect(isAllowedPeriodQueryDate("2026-06-13", now)).toBe(false);
    expect(isAllowedPeriodQueryDate("2099-01-01", now)).toBe(false);
  });

  it("allows only the canonical Monday for the current KST school week", async () => {
    const policyModule = await import("./period-query-policy");
    const isAllowedPeriodQueryWeekStart = (
      policyModule as typeof policyModule & {
        readonly isAllowedPeriodQueryWeekStart?: (weekStart: string, now: Date) => boolean;
      }
    ).isAllowedPeriodQueryWeekStart;
    const now = new Date("2026-06-11T09:00:00+09:00");

    expect(isAllowedPeriodQueryWeekStart).toBeTypeOf("function");
    if (!isAllowedPeriodQueryWeekStart) {
      return;
    }
    expect(isAllowedPeriodQueryWeekStart("2026-06-08", now)).toBe(true);
    expect(isAllowedPeriodQueryWeekStart("2026-06-01", now)).toBe(false);
    expect(isAllowedPeriodQueryWeekStart("2026-06-09", now)).toBe(false);
    expect(isAllowedPeriodQueryWeekStart("2026-06-15", now)).toBe(false);
  });
});
