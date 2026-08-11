import { describe, expect, it } from "vitest";

import {
  adminMutationFeedback,
  adminSettingsMutationFeedback,
  reconcileClosedPeriodNotificationFeedback,
  sendClosedPeriodNotificationFeedback
} from "./admin-mutation-feedback";

const retryableError = {
  kind: "error",
  message: "잠시 사용할 수 없습니다.",
  retryAfterMs: 1_001,
  retryable: true,
  status: 503
} as const;

describe("admin mutation feedback", () => {
  it("preserves an ordinary failed draft Given retry metadata When deciding feedback Then it does not refresh", () => {
    expect(adminMutationFeedback(retryableError, "저장했습니다.")).toEqual({
      message: "잠시 사용할 수 없습니다. 2초 후 다시 시도해 주세요.",
      refresh: "none"
    });
  });

  it.each([
    ["sent", "마감 명단을 전송했습니다."],
    ["failed", "마감 명단 전송에 실패했습니다. 알림 상태를 확인해 주세요."],
    ["unknown", "전송 결과를 확인할 수 없습니다. 알림 상태에서 확인해 주세요."]
  ] as const)("handles send %s Given transport success When deciding feedback Then it refreshes dashboard", (kind, message) => {
    expect(sendClosedPeriodNotificationFeedback({ data: { kind }, kind: "ok" })).toEqual({
      message,
      refresh: "dashboard"
    });
  });

  it.each([
    ["abandoned", "abandon", "알림 확인을 종료했습니다."],
    ["confirmed", "confirm_sent", "전송 완료로 처리했습니다."],
    ["sent", "retry", "마감 명단을 다시 전송했습니다."],
    ["failed", "retry", "재전송에 실패했습니다. 알림 상태를 확인해 주세요."],
    ["unknown", "retry", "재전송 결과를 확인할 수 없습니다. 알림 상태에서 확인해 주세요."]
  ] as const)("handles reconciliation %s Given transport success When deciding feedback Then it refreshes dashboard", (kind, action, message) => {
    expect(reconcileClosedPeriodNotificationFeedback({ data: { kind }, kind: "ok" }, action)).toEqual({
      message,
      refresh: "dashboard"
    });
  });

  it("refreshes stale notification state Given its 409 When deciding feedback Then the dashboard is reloaded", () => {
    expect(
      reconcileClosedPeriodNotificationFeedback(
        { ...retryableError, message: "알림 상태가 이미 변경되었습니다. 대시보드를 새로고침해 주세요.", retryAfterMs: null, retryable: false, status: 409 },
        "retry"
      )
    ).toEqual({ message: "알림 상태가 이미 변경되었습니다. 대시보드를 새로고침해 주세요.", refresh: "dashboard" });
  });

  it("preserves input Given an ordinary 409 When deciding feedback Then it does not refresh", () => {
    expect(
      reconcileClosedPeriodNotificationFeedback(
        { ...retryableError, message: "이미 처리되었습니다.", retryAfterMs: null, retryable: false, status: 409 },
        "retry"
      )
    ).toEqual({ message: "이미 처리되었습니다.", refresh: "none" });
  });

  it.each([
    ["both", { kind: "ok", data: {} }, { kind: "ok", data: {} }, true, true, "설정이 저장되었습니다."],
    ["periods", { kind: "ok", data: {} }, retryableError, true, false, "시간대는 저장되었습니다. 디스코드: 잠시 사용할 수 없습니다. 2초 후 다시 시도해 주세요."],
    ["notifications", retryableError, { kind: "ok", data: {} }, false, true, "디스코드 알림은 저장되었습니다. 시간대: 잠시 사용할 수 없습니다. 2초 후 다시 시도해 주세요."],
    ["neither", retryableError, retryableError, false, false, "시간대: 잠시 사용할 수 없습니다. 2초 후 다시 시도해 주세요. 디스코드: 잠시 사용할 수 없습니다. 2초 후 다시 시도해 주세요."]
  ] as const)("refreshes only %s resources Given paired saves When deciding feedback Then failed drafts remain", (_name, periods, notifications, refreshPeriods, refreshNotifications, message) => {
    expect(adminSettingsMutationFeedback({ notifications, periods })).toEqual({
      message,
      refreshNotifications,
      refreshPeriods
    });
  });
});
