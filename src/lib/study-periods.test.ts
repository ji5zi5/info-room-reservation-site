import { describe, expect, it } from "vitest";

import { DEFAULT_PERIOD_CAPACITY, STUDY_PERIODS, getStudyPeriodLabel } from "./study-periods";

describe("study period policy", () => {
  it("orders 8면학 before 1면학", () => {
    expect(STUDY_PERIODS).toEqual(["EIGHTH", "FIRST"]);
    expect(getStudyPeriodLabel("EIGHTH")).toBe("8면학");
    expect(getStudyPeriodLabel("FIRST")).toBe("1면학");
  });

  it("uses 10 seats as the default capacity", () => {
    expect(DEFAULT_PERIOD_CAPACITY).toBe(10);
  });
});
