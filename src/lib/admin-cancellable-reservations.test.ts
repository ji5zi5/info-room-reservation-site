import { describe, expect, it } from "vitest";

import { selectCancellableConfirmedReservationIds, type AdminCancellationCandidate } from "./admin-cancellable-reservations";
import type { PeriodSettingSnapshot } from "./period-setting-values";

const today = "2026-06-16";
const reservation = {
  date: today,
  id: "today",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH"
} satisfies AdminCancellationCandidate;
const settings = [
  {
    capacity: 10,
    closeTime: "16:20",
    date: today,
    enabled: true,
    openTime: "13:00",
    studyPeriod: "EIGHTH"
  }
] satisfies readonly PeriodSettingSnapshot[];

describe("admin confirmed reservation cancellation boundary", () => {
  it.each([
    ["one minute before close", "2026-06-16T07:19:00.000Z", ["today"]],
    ["exactly at close", "2026-06-16T07:20:00.000Z", ["today"]],
    ["one minute after close", "2026-06-16T07:21:00.000Z", []]
  ])("uses isPeriodWindowClosed equality semantics %s", (_label, now, expected) => {
    expect(
      selectCancellableConfirmedReservationIds({ now: new Date(now), reservations: [reservation], settings })
    ).toEqual(expected);
  });

  it("keeps past and non-confirmed rows while selecting future confirmed rows", () => {
    const reservations = [
      { ...reservation, date: "2026-06-15", id: "past" },
      { ...reservation, date: "2026-06-17", id: "future" },
      { ...reservation, date: "2026-06-17", id: "cancelled", status: "CANCELLED" },
      { ...reservation, date: "2026-06-17", id: "no-show", status: "NO_SHOW" }
    ] satisfies readonly AdminCancellationCandidate[];

    expect(
      selectCancellableConfirmedReservationIds({
        now: new Date("2026-06-16T07:21:00.000Z"),
        reservations,
        settings
      })
    ).toEqual(["future"]);
  });
});
