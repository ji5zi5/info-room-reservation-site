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

  it("does not select a period with an active sending delivery", () => {
    const freshSendingDelivery = {
      date: "2026-06-12",
      kind: CLOSED_LIST_NOTIFICATION_KIND,
      status: "SENDING",
      studyPeriod: "EIGHTH",
      updatedAt: new Date("2026-06-12T07:20:00.000Z")
    } as const;
    const deliveries = [
      freshSendingDelivery
    ] satisfies readonly ClosedPeriodDeliverySnapshot[];

    const candidates = selectClosedPeriodNotificationCandidates({
      deliveries,
      now: new Date("2026-06-12T07:25:00.000Z"),
      settings: [closedEighthSetting]
    });

    expect(candidates).toEqual([]);
  });

  it("does not automatically retry a stale sending delivery", () => {
    const staleSendingDelivery = {
      date: "2026-06-12",
      kind: CLOSED_LIST_NOTIFICATION_KIND,
      status: "SENDING",
      studyPeriod: "EIGHTH",
      updatedAt: new Date("2026-06-12T07:15:00.000Z")
    } as const;
    const deliveries = [
      staleSendingDelivery
    ] satisfies readonly ClosedPeriodDeliverySnapshot[];

    const candidates = selectClosedPeriodNotificationCandidates({
      deliveries,
      now: new Date("2026-06-12T07:25:00.000Z"),
      settings: [closedEighthSetting]
    });

    expect(candidates).toEqual([]);
  });

  it("does not automatically send unresolved reconciliation states", () => {
    for (const status of ["UNKNOWN", "PENDING_REVIEW"] as const) {
      expect(
        selectClosedPeriodNotificationCandidates({
          deliveries: [
            {
              date: "2026-06-12",
              kind: CLOSED_LIST_NOTIFICATION_KIND,
              status,
              studyPeriod: "EIGHTH",
              updatedAt: new Date("2026-06-12T07:20:00.000Z")
            }
          ],
          now: new Date("2026-06-12T07:25:00.000Z"),
          settings: [closedEighthSetting]
        })
      ).toEqual([]);
    }
  });

  it("waits for a failed delivery backoff before retrying", () => {
    const failedDelivery = {
      date: "2026-06-12",
      kind: CLOSED_LIST_NOTIFICATION_KIND,
      nextAttemptAt: new Date("2026-06-12T07:26:00.000Z"),
      status: "FAILED",
      studyPeriod: "EIGHTH"
    } as const;

    expect(
      selectClosedPeriodNotificationCandidates({
        deliveries: [failedDelivery],
        now: new Date("2026-06-12T07:25:00.000Z"),
        settings: [closedEighthSetting]
      })
    ).toEqual([]);
    expect(
      selectClosedPeriodNotificationCandidates({
        deliveries: [failedDelivery],
        now: new Date("2026-06-12T07:26:00.000Z"),
        settings: [closedEighthSetting]
      })
    ).toEqual([closedEighthSetting]);
  });

  it("does not treat the exact close minute as closed until the next minute", () => {
    expect(
      isClosedPeriodForNotification(closedEighthSetting, new Date("2026-06-12T07:20:00.000Z"))
    ).toBe(false);
    expect(
      isClosedPeriodForNotification(closedEighthSetting, new Date("2026-06-12T07:21:00.000Z"))
    ).toBe(true);
  });

  it("does not close future notification candidates after today's close time", () => {
    expect(
      isClosedPeriodForNotification(closedEighthSetting, new Date("2026-06-11T07:21:00.000Z"))
    ).toBe(false);
  });
});
