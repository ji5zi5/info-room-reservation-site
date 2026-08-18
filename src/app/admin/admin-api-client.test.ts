import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyUserRestriction,
  bulkCancelAdminReservations,
  cancelAdminReservation,
  fetchAdminDashboard,
  fetchAdminNotificationSettings,
  fetchAdminOperations,
  fetchAdminSettings,
  markReservationNoShow,
  reconcileClosedPeriodNotification,
  repairDiscordOperation,
  removeUserRestriction,
  saveAdminNotificationSettings,
  saveAdminSettings,
  sendClosedPeriodNotification
} from "./admin-api-client";
import { AdminOperationItemSchema, AdminOperationsPayloadSchema, type AdminDashboardPeriod } from "./admin-types";

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
      code: null,
      kind: "error",
      message: "관리자 데이터를 불러오지 못했습니다."
    });
  });

  it("parses the strict operations payload and rejects malformed job health", async () => {
    // Given: one valid response followed by a payload missing the required health code.
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(operationsPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...operationsPayload, jobs: [{ ...operationsPayload.jobs[0], health: { status: "ok" } }] }), { status: 200 }))
    );

    // When / Then: valid network data crosses Zod once and malformed data is rejected.
    await expect(fetchAdminOperations()).resolves.toEqual({ data: operationsPayload, kind: "ok" });
    await expect(fetchAdminOperations()).resolves.toEqual({ kind: "error", message: "운영 작업 응답 형식이 올바르지 않습니다." });
  });

  it("sends expected state and reservation-bound confirmation for repairs", async () => {
    // Given: one destructive action that passed the visible confirmation dialog.
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ result: { auditActionId: "audit-new", kind: "repaired" } }), { status: 200 }));

    // When: the operation repair client submits the row contract.
    await expect(repairDiscordOperation(AdminOperationItemSchema.parse(operationsPayload.backlogs.initialSends.items[0]), "abandon", "reservation-initial")).resolves.toEqual({
      data: { result: { auditActionId: "audit-new", kind: "repaired" } },
      kind: "ok"
    });

    // Then: CSRF transport carries the stale-state guard and destructive confirmation.
    expect(csrfFetchMock).toHaveBeenCalledWith("/api/admin/discord/reservations/reconcile", expect.objectContaining({
      body: JSON.stringify({
        action: "abandon",
        confirmation: "reservation-initial",
        expectedControlEpoch: 7,
        expectedState: "PENDING_REVIEW",
        reservationId: "reservation-initial"
      }),
      method: "POST"
    }));
  });

  it("preserves a 409 operation conflict as truthful non-retryable row feedback", async () => {
    // Given: another operator has already changed the row.
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Discord 복구 충돌: stale_state" } }), { status: 409 }));

    // When / Then: the client preserves the conflict and does not pretend the row disappeared.
    await expect(repairDiscordOperation(AdminOperationItemSchema.parse(operationsPayload.backlogs.interactions.items[0]), "retry")).resolves.toEqual({
      kind: "error",
      message: "Discord 복구 충돌: stale_state",
      retryAfterMs: null,
      retryable: false,
      status: 409
    });
  });

  it("normalizes admin time fields before saving period settings", async () => {
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ periods: [periodSetting] }), { status: 200 }));

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
    ).resolves.toEqual({ data: { periods: [periodSetting] }, kind: "ok" });

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
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ notificationSettings }), { status: 200 }));

    await expect(
      saveAdminNotificationSettings({
        closedPeriodNotificationsEnabled: false,
        id: "global",
        reservationCreatedNotificationsEnabled: true
      })
    ).resolves.toEqual({ data: { notificationSettings }, kind: "ok" });

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
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify(reconcileResult), { status: 200 }));

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
    ).resolves.toEqual({ data: reconcileResult, kind: "ok" });

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
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ cancelledFutureReservationCount: 0, user }), { status: 200 }));

    await expect(
      applyUserRestriction("user-1", {
        days: null,
        reason: "블랙리스트",
        shadowBanProfile: "HIGH",
        status: "SHADOW_BANNED"
      })
    ).resolves.toEqual({ data: { cancelledFutureReservationCount: 0, user }, kind: "ok" });

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/users/user-1/restriction");
    expect(request?.body).toBe(
      JSON.stringify({ days: null, reason: "블랙리스트", shadowBanProfile: "HIGH", status: "SHADOW_BANNED" })
    );
  });

  it("sends only a no-show reason when marking a reservation no-show", async () => {
    csrfFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ cancelledFutureReservationCount: 2, reservation, user }), { status: 200 })
    );

    await expect(markReservationNoShow("reservation-1")).resolves.toEqual({
      data: { cancelledFutureReservationCount: 2, reservation, user },
      kind: "ok"
    });

    const request = csrfFetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(request?.body).toBe(JSON.stringify({ reason: "정보실 예약 노쇼" }));
  });

  it("sends an admin cancellation reason when cancelling a reservation", async () => {
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ reservation }), { status: 200 }));

    await expect(cancelAdminReservation("reservation-1", "행사 준비로 정보실 사용 불가")).resolves.toEqual({
      data: { reservation },
      kind: "ok"
    });

    const [url, request] = csrfFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/reservations/reservation-1/cancel");
    expect(request).toBeDefined();
    expect(request?.body).toBe(JSON.stringify({ reason: "행사 준비로 정보실 사용 불가" }));
    expect(request?.headers).toEqual({ "content-type": "application/json" });
  });

  it("posts a strict bulk cancellation preview and parses every per-item result", async () => {
    // Given: the server reports one cancellable row and one row that changed after selection.
    const payload = {
      results: [
        { reservationId: "reservation-1", status: "cancelled" },
        { reservationId: "reservation-2", status: "invalid_status" }
      ],
      summary: { cancelled: 1, conflict: 0, invalidStatus: 1, notFound: 0, total: 2 }
    };
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    // When / Then: preview uses the existing CSRF mutation transport and returns parsed data.
    await expect(bulkCancelAdminReservations({
      mode: "preview",
      reason: "운영 일정 변경",
      reservationIds: ["reservation-1", "reservation-2"]
    })).resolves.toEqual({ data: payload, kind: "ok" });
    expect(csrfFetchMock).toHaveBeenCalledWith("/api/admin/reservations/bulk-cancel", expect.objectContaining({
      body: JSON.stringify({
        mode: "preview",
        reason: "운영 일정 변경",
        reservationIds: ["reservation-1", "reservation-2"]
      }),
      method: "POST"
    }));
  });

  it("rejects a malformed bulk cancellation success payload instead of inferring success", async () => {
    // Given: the summary says two items while the result list omits required status data.
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [{ reservationId: "reservation-1" }],
      summary: { cancelled: 2, conflict: 0, invalidStatus: 0, notFound: 0, total: 2 }
    }), { status: 200 }));

    // When / Then: strict boundary parsing returns a non-retryable payload error.
    await expect(bulkCancelAdminReservations({
      mode: "execute",
      reason: "운영 일정 변경",
      reservationIds: ["reservation-1", "reservation-2"]
    })).resolves.toEqual({
      kind: "error",
      message: "예약 일괄 취소에 실패했습니다.",
      retryAfterMs: null,
      retryable: false,
      status: 200
    });
  });

  it("rejects shape-valid bulk results that do not match the requested reservation order", async () => {
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [
        { reservationId: "reservation-2", status: "cancelled" },
        { reservationId: "reservation-other", status: "cancelled" }
      ],
      summary: { cancelled: 2, conflict: 0, invalidStatus: 0, notFound: 0, total: 2 }
    }), { status: 200 }));

    await expect(bulkCancelAdminReservations({
      mode: "preview",
      reason: "운영 일정 변경",
      reservationIds: ["reservation-1", "reservation-2"]
    })).resolves.toMatchObject({
      kind: "error",
      message: "예약 일괄 취소에 실패했습니다.",
      status: 200
    });
  });

  it.each([
    ["period settings", () => saveAdminSettings({ date: "2026-06-16", periods: [periodSetting] }), "시간대 설정 저장에 실패했습니다."],
    ["notification settings", () => saveAdminNotificationSettings(notificationSettings), "알림 설정 저장에 실패했습니다."],
    ["closed-list send", () => sendClosedPeriodNotification(dashboardPeriod), "마감 명단 전송에 실패했습니다."],
    ["reconciliation", () => reconcileClosedPeriodNotification(notificationItem, "retry"), "알림 상태 조정에 실패했습니다."],
    ["cancellation", () => cancelAdminReservation("reservation-1", "사유"), "예약 취소에 실패했습니다."],
    ["no-show", () => markReservationNoShow("reservation-1"), "노쇼 처리에 실패했습니다."],
    ["restriction apply", () => applyUserRestriction("user-1", { days: 7, reason: "사유", status: "RESTRICTED" }), "학생 제재 적용에 실패했습니다."],
    ["restriction remove", () => removeUserRestriction("user-1"), "학생 제재 해제에 실패했습니다."]
  ] as const)("returns structured fallback for malformed 2xx Given %s When parsing Then operation is an error", async (_name, invoke, fallback) => {
    csrfFetchMock.mockResolvedValue(new Response("{}", { headers: { "Retry-After": "5" }, status: 200 }));
    await expect(invoke()).resolves.toEqual({
      kind: "error",
      message: fallback,
      retryAfterMs: null,
      retryable: false,
      status: 200
    });
  });

  it("preserves validated success data Given each endpoint response When parsing Then callers receive the union", async () => {
    csrfFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ periods: [periodSetting] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notificationSettings }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sendResult), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reconcileResult), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ reservation }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cancelledFutureReservationCount: 2, reservation, user }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cancelledFutureReservationCount: 0, user }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user }), { status: 200 }));

    await expect(saveAdminSettings({ date: "2026-06-16", periods: [periodSetting] })).resolves.toEqual({ data: { periods: [periodSetting] }, kind: "ok" });
    await expect(saveAdminNotificationSettings(notificationSettings)).resolves.toEqual({ data: { notificationSettings }, kind: "ok" });
    await expect(sendClosedPeriodNotification(dashboardPeriod)).resolves.toEqual({ data: sendResult, kind: "ok" });
    await expect(reconcileClosedPeriodNotification(notificationItem, "retry")).resolves.toEqual({ data: reconcileResult, kind: "ok" });
    await expect(cancelAdminReservation("reservation-1", "사유")).resolves.toEqual({ data: { reservation }, kind: "ok" });
    await expect(markReservationNoShow("reservation-1")).resolves.toEqual({ data: { cancelledFutureReservationCount: 2, reservation, user }, kind: "ok" });
    await expect(applyUserRestriction("user-1", { days: 7, reason: "사유", status: "RESTRICTED" })).resolves.toEqual({ data: { cancelledFutureReservationCount: 0, user }, kind: "ok" });
    await expect(removeUserRestriction("user-1")).resolves.toEqual({ data: { user }, kind: "ok" });
  });

  it("preserves CSRF server text Given a 403 response When parsing Then it is non-retryable", async () => {
    csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "보안 토큰이 올바르지 않습니다." } }), { status: 403 }));
    await expect(cancelAdminReservation("reservation-1", "사유")).resolves.toEqual({
      kind: "error",
      message: "보안 토큰이 올바르지 않습니다.",
      retryAfterMs: null,
      retryable: false,
      status: 403
    });
  });

  it("preserves conflict text Given notification state changed When parsing Then non-retryable headers are ignored", async () => {
    csrfFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "알림 상태가 이미 변경되었습니다. 대시보드를 새로고침해 주세요." } }),
        { headers: { "Retry-After": "5" }, status: 409 }
      )
    );
    await expect(reconcileClosedPeriodNotification(notificationItem, "retry")).resolves.toEqual({
      kind: "error",
      message: "알림 상태가 이미 변경되었습니다. 대시보드를 새로고침해 주세요.",
      retryAfterMs: null,
      retryable: false,
      status: 409
    });
  });

  it.each([[429, "2", 2_000], [503, "Mon, 01 Jun 2026 00:00:03 GMT", 3_000]] as const)(
    "parses Retry-After Given HTTP %s When mutation fails Then retry metadata is exact",
    async (status, retryAfter, retryAfterMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      csrfFetchMock.mockResolvedValue(new Response("not-json", { headers: { "Retry-After": retryAfter }, status }));
      await expect(sendClosedPeriodNotification(dashboardPeriod)).resolves.toEqual({
        kind: "error",
        message: "마감 명단 전송에 실패했습니다.",
        retryAfterMs,
        retryable: true,
        status
      });
      vi.useRealTimers();
    }
  );

  it.each(["invalid", "-1", "Sun, 31 May 2026 23:59:59 GMT"])("ignores invalid or past Retry-After %s", async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    csrfFetchMock.mockResolvedValue(new Response("", { headers: { "Retry-After": retryAfter }, status: 503 }));
    await expect(removeUserRestriction("user-1")).resolves.toMatchObject({ retryAfterMs: null, retryable: true });
    vi.useRealTimers();
  });

  it("returns a retryable network result Given csrfFetch rejects When mutating Then failure is actionable", async () => {
    csrfFetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(markReservationNoShow("reservation-1")).resolves.toEqual({
      kind: "error",
      message: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
      retryAfterMs: null,
      retryable: true,
      status: null
    });
  });

  it("returns a retryable network result Given csrfFetch rejects with a string When mutating Then failure is actionable", async () => {
    csrfFetchMock.mockRejectedValue("offline");

    await expect(markReservationNoShow("reservation-1")).resolves.toEqual({
      kind: "error",
      message: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
      retryAfterMs: null,
      retryable: true,
      status: null
    });
  });

  it("returns a retryable network result Given response text rejects with an object When mutating Then failure is actionable", async () => {
    const response = new Response("{}", { status: 200 });
    const textSpy = vi.spyOn(response, "text").mockRejectedValue({ reason: "body unavailable" });
    csrfFetchMock.mockResolvedValue(response);

    await expect(markReservationNoShow("reservation-1")).resolves.toEqual({
      kind: "error",
      message: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
      retryAfterMs: null,
      retryable: true,
      status: null
    });

    textSpy.mockRestore();
  });

  it("returns the operation fallback Given a successful response has malformed JSON When parsing Then it is not a network failure", async () => {
    csrfFetchMock.mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(markReservationNoShow("reservation-1")).resolves.toEqual({
      kind: "error",
      message: "노쇼 처리에 실패했습니다.",
      retryAfterMs: null,
      retryable: false,
      status: 200
    });
  });

  it.each([
    ["period settings", () => saveAdminSettings({ date: "2026-06-16", periods: [periodSetting] }), "시간대 설정 저장에 실패했습니다."],
    ["notification settings", () => saveAdminNotificationSettings(notificationSettings), "알림 설정 저장에 실패했습니다."],
    ["closed-list send", () => sendClosedPeriodNotification(dashboardPeriod), "마감 명단 전송에 실패했습니다."],
    ["reconciliation", () => reconcileClosedPeriodNotification(notificationItem, "retry"), "알림 상태 조정에 실패했습니다."],
    ["cancellation", () => cancelAdminReservation("reservation-1", "사유"), "예약 취소에 실패했습니다."],
    ["no-show", () => markReservationNoShow("reservation-1"), "노쇼 처리에 실패했습니다."],
    ["restriction apply", () => applyUserRestriction("user-1", { days: 7, reason: "사유", status: "RESTRICTED" }), "학생 제재 적용에 실패했습니다."],
    ["restriction remove", () => removeUserRestriction("user-1"), "학생 제재 해제에 실패했습니다."]
  ] as const)("uses the helper fallback Given malformed non-2xx for %s When parsing Then status remains actionable", async (_name, invoke, fallback) => {
    csrfFetchMock.mockResolvedValue(new Response("not-json", { status: 500 }));
    await expect(invoke()).resolves.toEqual({
      kind: "error",
      message: fallback,
      retryAfterMs: null,
      retryable: false,
      status: 500
    });
  });

  it.each([
    ["period settings", () => saveAdminSettings({ date: "2026-06-16", periods: [periodSetting] })],
    ["notification settings", () => saveAdminNotificationSettings(notificationSettings)],
    ["closed-list send", () => sendClosedPeriodNotification(dashboardPeriod)],
    ["reconciliation", () => reconcileClosedPeriodNotification(notificationItem, "retry")],
    ["cancellation", () => cancelAdminReservation("reservation-1", "사유")],
    ["no-show", () => markReservationNoShow("reservation-1")],
    ["restriction apply", () => applyUserRestriction("user-1", { days: 7, reason: "사유", status: "RESTRICTED" })],
    ["restriction remove", () => removeUserRestriction("user-1")]
  ] as const)("returns the network union Given %s throws When mutating Then retry is allowed", async (_name, invoke) => {
    csrfFetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(invoke()).resolves.toEqual({
      kind: "error",
      message: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
      retryAfterMs: null,
      retryable: true,
      status: null
    });
  });
});

const periodSetting = {
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 0,
  date: "2026-06-16",
  enabled: true,
  label: "8면학",
  openTime: "13:00",
  remaining: 10,
  studyPeriod: "EIGHTH",
  windowState: "open"
} as const;

const notificationSettings = {
  closedPeriodNotificationsEnabled: false,
  id: "global",
  reservationCreatedNotificationsEnabled: true
} as const;

const notificationItem = {
  attempts: 1,
  date: "2026-06-12",
  failureCode: "discord_timeout",
  lastError: "timeout",
  nextAttemptAt: null,
  status: "UNKNOWN",
  studyPeriod: "EIGHTH",
  updatedAt: "2026-06-12T07:25:00.000Z"
} as const;

const delivery = {
  date: "2026-06-12",
  kind: "CLOSED_LIST",
  status: "SENT",
  studyPeriod: "EIGHTH",
  updatedAt: "2026-06-12T07:25:00.000Z"
} as const;

const sendResult = { delivery, kind: "sent" } as const;
const reconcileResult = { delivery, kind: "sent", previousStatus: "UNKNOWN" } as const;

const reservation = {
  createdAt: "2026-06-12T00:00:00.000Z",
  date: "2026-06-12",
  id: "reservation-1",
  reason: null,
  status: "CANCELLED",
  studyPeriod: "EIGHTH",
  updatedAt: "2026-06-12T00:00:00.000Z",
  userId: "user-1"
} as const;

const user = {
  bookingStatus: "RESTRICTED",
  generation: 1,
  id: "user-1",
  name: "학생",
  restrictedUntil: null,
  restrictionReason: "사유",
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "10101"
} as const;

const dashboardPeriod: AdminDashboardPeriod = {
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
};

const operationCommon = {
  createdAt: "2026-08-12T22:00:00.000Z",
  expectedControlEpoch: 7,
  latestAuditActionId: "audit-1",
  reservationId: "reservation-initial",
  updatedAt: "2026-08-12T23:00:00.000Z",
  userId: "user-1"
} as const;

const operationsPayload = AdminOperationsPayloadSchema.parse({
  backlogs: {
    initialSends: { count: 1, items: [{ ...operationCommon, attempts: 1, expectedState: "PENDING_REVIEW", id: "initial-1", kind: "initial_send", permittedActions: ["verify_remote", "abandon"], remoteVerificationStatus: "ZERO_COMPLETE", status: "PENDING_REVIEW" }], oldestAgeMs: 3_600_000 },
    interactions: { count: 1, items: [{ ...operationCommon, attempts: 2, errorCode: "discord_http_500", expectedState: "RETRY", id: "interaction-1", kind: "interaction", permittedActions: ["retry"], status: "RETRY" }], oldestAgeMs: 7_200_000 },
    syncs: { count: 0, items: [], oldestAgeMs: null }
  },
  control: { enabled: true, epoch: 7, pendingRemoteCleanup: false },
  generatedAt: "2026-08-13T00:00:00.000Z",
  jobs: [{ backlogCount: 0, failureCode: null, health: { code: "healthy", status: "ok" }, job: "CLOSED_PERIOD_NOTIFICATIONS", lastAttemptAt: "2026-08-12T23:59:30.000Z", lastSuccessAt: "2026-08-12T23:59:30.000Z", status: "SUCCEEDED" }, { backlogCount: 1, failureCode: "discord_http_500", health: { code: "last_attempt_failed", status: "degraded" }, job: "DISCORD_INTERACTIONS", lastAttemptAt: "2026-08-12T23:59:00.000Z", lastSuccessAt: null, status: "FAILED" }, { backlogCount: 0, failureCode: null, health: { code: "healthy", status: "ok" }, job: "DISCORD_RESERVATION_OUTBOX", lastAttemptAt: "2026-08-12T23:59:30.000Z", lastSuccessAt: "2026-08-12T23:59:30.000Z", status: "SUCCEEDED" }]
});
