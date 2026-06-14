import { describe, expect, it } from "vitest";

import { canAdminCancelReservation, canMarkReservationNoShow } from "./admin-reservation-transition";

describe("admin reservation transitions", () => {
  it("allows admin cancel and no-show only from confirmed reservations", () => {
    expect(canAdminCancelReservation("CONFIRMED")).toBe(true);
    expect(canAdminCancelReservation("CANCELLED")).toBe(false);
    expect(canAdminCancelReservation("NO_SHOW")).toBe(false);

    expect(canMarkReservationNoShow("CONFIRMED")).toBe(true);
    expect(canMarkReservationNoShow("CANCELLED")).toBe(false);
    expect(canMarkReservationNoShow("NO_SHOW")).toBe(false);
  });
});
