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
});
