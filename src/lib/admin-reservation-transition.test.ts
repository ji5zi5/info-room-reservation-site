import { describe, expect, it } from "vitest";

import { canAdminCancelReservation, canMarkReservationNoShow } from "./admin-reservation-transition";

describe("admin reservation transitions", () => {
  it("allows admin cancel only from confirmed reservations", () => {
    expect(canAdminCancelReservation("CONFIRMED")).toBe(true);
    expect(canAdminCancelReservation("CANCELLED")).toBe(false);
    expect(canAdminCancelReservation("NO_SHOW")).toBe(false);
  });

  it("allows no-show only for confirmed reservations after the effective period closes", () => {
    expect(canMarkReservationNoShow("CONFIRMED", "closed")).toBe(true);
    expect(canMarkReservationNoShow("CONFIRMED", "open")).toBe(false);
    expect(canMarkReservationNoShow("CONFIRMED", "not_open_yet")).toBe(false);
    expect(canMarkReservationNoShow("CANCELLED", "closed")).toBe(false);
    expect(canMarkReservationNoShow("NO_SHOW", "closed")).toBe(false);
  });
});
