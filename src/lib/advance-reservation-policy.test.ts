import { describe, expect, it } from "vitest";

import { isSelectableAdvanceDate, type AdvanceReservationPolicy } from "./advance-reservation-policy";

describe("advance reservation policy", () => {
  it("accepts only dates inside the available advance window", () => {
    // Given: Thursday's policy only allows Friday as the advance date.
    const policy = {
      kind: "available",
      maxDate: "2026-06-12",
      minDate: "2026-06-12",
      today: "2026-06-11"
    } satisfies AdvanceReservationPolicy;

    // When: previous, allowed, and next-week date values are checked.
    const selectableDates = ["2026-06-10", "2026-06-12", "2026-06-15"].map((date) =>
      isSelectableAdvanceDate(date, policy)
    );

    // Then: only the date inside the current-week advance window is selectable.
    expect(selectableDates).toEqual([false, true, false]);
  });

  it("rejects every advance date when the policy is unavailable", () => {
    // Given: Friday's policy closes advance reservation.
    const policy = {
      kind: "unavailable",
      message: "사전예약 불가",
      today: "2026-06-12"
    } satisfies AdvanceReservationPolicy;

    // When: a future date is checked against the unavailable policy.
    const selectable = isSelectableAdvanceDate("2026-06-15", policy);

    // Then: no advance date can be selected.
    expect(selectable).toBe(false);
  });
});
