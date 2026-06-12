import { describe, expect, it } from "vitest";

import { DEFAULT_PERIOD_CLOSE_TIME, DEFAULT_PERIOD_OPEN_TIME, findMyReservationId } from "./period-settings";

describe("period summary my reservation marker", () => {
  it("returns only the current user's reservation for the matching period", () => {
    const applicants = [
      { reservationId: "other-eighth", studyPeriod: "EIGHTH", userId: "other" },
      { reservationId: "mine-first", studyPeriod: "FIRST", userId: "me" },
      { reservationId: "mine-eighth", studyPeriod: "EIGHTH", userId: "me" }
    ] as const;

    expect(findMyReservationId("EIGHTH", applicants, "me")).toBe("mine-eighth");
    expect(findMyReservationId("FIRST", applicants, "me")).toBe("mine-first");
    expect(findMyReservationId("EIGHTH", applicants, "missing")).toBeNull();
  });
});

describe("period setting defaults", () => {
  it("opens at 13:00 and closes at 16:20 by default", () => {
    expect(DEFAULT_PERIOD_OPEN_TIME).toBe("13:00");
    expect(DEFAULT_PERIOD_CLOSE_TIME).toBe("16:20");
  });
});
