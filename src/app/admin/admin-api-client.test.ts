import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyUserRestriction,
  cancelAdminReservation,
  fetchAdminDashboard,
  fetchAdminNotificationSettings,
  fetchAdminSettings,
  markReservationNoShow,
  reconcileClosedPeriodNotification,
  saveAdminNotificationSettings,
  saveAdminSettings
} from "./admin-api-client";

const csrfFetchMock = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);

vi.mock("../csrf-fetch", () => ({
  csrfFetch: csrfFetchMock
}));

describe("admin api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    csrfFetchMock.mockReset();
  });

  it("returns a failure result instead of hiding empty error responses", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await expect(fetchAdminSettings("2026-06-14")).resolves.toEqual({
      kind: "error",
      message: "관리자 데이터를 불러오지 못했습니다."
    });
  });

  it("normalizes admin time fields before saving period settings", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      saveAdminSettings({
        date: "2026-06-16",
        periods: [
          {
            capacity: 10,
            closeTime: "4:05",
            confirmedCount: 0,
            date: "2026-06-16",
            enabled: true,
            label: "8면학",
            openTime: " 3:00 ",
            remaining: 10,
            studyPeriod: "EIGHTH",
            windowState: "open"
          }
        ]
      })
    ).resolves.toBe(true);

    const request = csrfFetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(request?.body).toBe(
      JSON.stringify({
        date: "2026-06-16",
        periods: [
          {
            capacity: 10,
            closeTime: "04:05",
            confirmedCount: 0,
            date: "2026-06-16",
            enabled: true,
            label: "8면학",
            openTime: "03:00",
            remaining: 10,
            studyPeriod: "EIGHTH",
            windowState: "open"
          }
        ]
      })
    );
  });

  it("reads Discord notification settings from the separate admin endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            notificationSettings: {
              closedPeriodNotificationsEnabled: true,
              id: "global",
              reservationCreatedNotificationsEnabled: false
            }
          }),
          { status: 200 }
        )
    );

    await expect(fetchAdminNotificationSettings()).resolves.toEqual({
      data: {
        closedPeriodNotificationsEnabled: true,
        id: "global",
        reservationCreatedNotificationsEnabled: false
      },
      kind: "ok"
    });
  });

  it("reads periods and the bounded notification reconciliation backlog together", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            notificationBacklog: [
              {
                attempts: 1,
                date: "2026-06-12",
                failureCode: "discord_timeout",
                lastError: "Discord response timed out",
                nextAttemptAt: null,
                status: "UNKNOWN",
                studyPeriod: "EIGHTH",
                updatedAt: "2026-06-12T07:25:00.000Z"
              }
            ],
            periods: [dashboardPeriod]
          }),
          { status: 200 }
        )
    );

    await expect(fetchAdminDashboard("2026-06-12")).resolves.toEqual({
      data: {
        notificationBacklog: [
          expect.objectContaining({
            date: "2026-06-12",
            status: "UNKNOWN",
            studyPeriod: "EIGHTH"
          })
        ],
        periods: [dashboardPeriod]
      },
      kind: "ok"
    });
  });

  it("saves only Discord notification toggle values", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      saveAdminNotificationSettings({
        closedPeriodNotificationsEnabled: false,
        id: "global",
        reservationCreatedNotificationsEnabled: true
      })
    ).resolves.toBe(true);

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/notification-settings");
    expect(request?.body).toBe(
      JSON.stringify({
        notificationSettings: {
          closedPeriodNotificationsEnabled: false,
          reservationCreatedNotificationsEnabled: true
        }
      })
    );
  });

  it("sends only the delivery identity and selected reconciliation action", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      reconcileClosedPeriodNotification(
        {
          attempts: 1,
          date: "2026-06-12",
          failureCode: "discord_timeout",
          lastError: "Discord response timed out",
          nextAttemptAt: null,
          status: "UNKNOWN",
          studyPeriod: "EIGHTH",
          updatedAt: "2026-06-12T07:25:00.000Z"
        },
        "confirm_sent"
      )
    ).resolves.toBe(true);

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/notifications/closed-periods/reconcile");
    expect(request?.body).toBe(
      JSON.stringify({
        action: "confirm_sent",
        date: "2026-06-12",
        studyPeriod: "EIGHTH"
      })
    );
  });

  it("sends the selected shadow-ban profile when applying a restriction", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      applyUserRestriction("user-1", {
        days: null,
        reason: "블랙리스트",
        shadowBanProfile: "HIGH",
        status: "SHADOW_BANNED"
      })
    ).resolves.toBe(true);

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/users/user-1/restriction");
    expect(request?.body).toBe(
      JSON.stringify({ days: null, reason: "블랙리스트", shadowBanProfile: "HIGH", status: "SHADOW_BANNED" })
    );
  });

  it("sends only a no-show reason when marking a reservation no-show", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(markReservationNoShow("reservation-1")).resolves.toBe(true);

    const request = csrfFetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(request?.body).toBe(JSON.stringify({ reason: "정보실 예약 노쇼" }));
  });

  it("sends an admin cancellation reason when cancelling a reservation", async () => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(cancelAdminReservation("reservation-1", "행사 준비로 정보실 사용 불가")).resolves.toBe(true);

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/reservations/reservation-1/cancel");
    expect(request).toBeDefined();
    expect(request?.body).toBe(JSON.stringify({ reason: "행사 준비로 정보실 사용 불가" }));
    expect(request?.headers).toEqual({ "content-type": "application/json" });
  });
});

const dashboardPeriod = {
  applicants: [],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 3,
  date: "2026-06-12",
  enabled: true,
  isClosed: true,
  label: "8면학",
  notification: null,
  openTime: "13:00",
  remaining: 7,
  studyPeriod: "EIGHTH",
  windowState: "closed"
} as const;
