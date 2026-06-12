import { describe, expect, it } from "vitest";

import {
  CLOSED_LIST_NOTIFICATION_KIND,
  isClosedPeriodForNotification,
  selectClosedPeriodNotificationCandidates,
  type ClosedPeriodCandidate,
  type ClosedPeriodDeliverySnapshot
} from "./closed-period-notifications";

const settings = [
  {
    capacity: 10,
    closeTime: "16:20",
    date: "2026-06-12",
    enabled: true,
    openTime: "13:00",
    studyPeriod: "EIGHTH"
  },
  {
    capacity: 10,
    closeTime: "16:20",
    date: "2026-06-12",
    enabled: true,
    openTime: "13:00",
    studyPeriod: "FIRST"
  },
  {
    capacity: 10,
    closeTime: "23:00",
    date: "2026-06-12",
    enabled: true,
    openTime: "13:00",
    studyPeriod: "EIGHTH"
  }
] satisfies readonly ClosedPeriodCandidate[];

const closedEighthSetting = {
  capacity: 10,
  closeTime: "16:20",
  date: "2026-06-12",
  enabled: true,
  openTime: "13:00",
  studyPeriod: "EIGHTH"
} satisfies ClosedPeriodCandidate;

describe("closed period notification candidate selection", () => {
  it("selects only KST-closed enabled periods without sent deliveries", () => {
    const deliveries = [
      {
        date: "2026-06-12",
        kind: CLOSED_LIST_NOTIFICATION_KIND,
        status: "SENT",
        studyPeriod: "FIRST"
      }
    ] satisfies readonly ClosedPeriodDeliverySnapshot[];

    const candidates = selectClosedPeriodNotificationCandidates({
      deliveries,
      now: new Date("2026-06-12T07:25:00.000Z"),
      settings
    });

    expect(candidates.map((candidate) => `${candidate.date}:${candidate.studyPeriod}`)).toEqual([
      "2026-06-12:EIGHTH"
    ]);
  });

  it("does not treat the exact close minute as closed until the next minute", () => {
    expect(
      isClosedPeriodForNotification(closedEighthSetting, new Date("2026-06-12T07:20:00.000Z"))
    ).toBe(false);
    expect(
      isClosedPeriodForNotification(closedEighthSetting, new Date("2026-06-12T07:21:00.000Z"))
    ).toBe(true);
  });
});
