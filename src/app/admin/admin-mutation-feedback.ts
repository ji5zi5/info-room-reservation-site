import type {
  AdminMutationResult,
  ReconcileClosedPeriodNotificationData,
  SendClosedPeriodNotificationData
} from "./admin-api-client";
import { adminSettingsSaveMessage, mutationErrorMessage } from "./admin-settings-save-result";
import type { AdminNotificationReconciliationAction } from "./admin-types";

export type AdminMutationFeedbackDecision = {
  readonly message: string;
  readonly refresh: "active" | "dashboard" | "none";
};

export type AdminSettingsMutationFeedbackDecision = {
  readonly message: string;
  readonly refreshNotifications: boolean;
  readonly refreshPeriods: boolean;
};

export function adminMutationFeedback<T>(
  result: AdminMutationResult<T>,
  successMessage: string
): AdminMutationFeedbackDecision {
  return result.kind === "ok"
    ? { message: successMessage, refresh: "active" }
    : { message: mutationErrorMessage(result), refresh: "none" };
}

export function sendClosedPeriodNotificationFeedback(
  result: AdminMutationResult<Pick<SendClosedPeriodNotificationData, "kind">>
): AdminMutationFeedbackDecision {
  if (result.kind === "error") {
    return { message: mutationErrorMessage(result), refresh: "none" };
  }
  switch (result.data.kind) {
    case "sent":
      return { message: "마감 명단을 전송했습니다.", refresh: "dashboard" };
    case "failed":
      return { message: "마감 명단 전송에 실패했습니다. 알림 상태를 확인해 주세요.", refresh: "dashboard" };
    case "unknown":
      return { message: "전송 결과를 확인할 수 없습니다. 알림 상태에서 확인해 주세요.", refresh: "dashboard" };
  }
}

export function reconcileClosedPeriodNotificationFeedback(
  result: AdminMutationResult<Pick<ReconcileClosedPeriodNotificationData, "kind">>,
  action: AdminNotificationReconciliationAction
): AdminMutationFeedbackDecision {
  if (result.kind === "error") {
    return {
      message: mutationErrorMessage(result),
      refresh:
        result.status === 409 && result.message === "알림 상태가 이미 변경되었습니다. 대시보드를 새로고침해 주세요."
          ? "dashboard"
          : "none"
    };
  }
  switch (result.data.kind) {
    case "abandoned":
    case "confirmed":
    case "sent":
      return { message: reconciliationSuccessMessage(action), refresh: "dashboard" };
    case "failed":
      return { message: "재전송에 실패했습니다. 알림 상태를 확인해 주세요.", refresh: "dashboard" };
    case "unknown":
      return { message: "재전송 결과를 확인할 수 없습니다. 알림 상태에서 확인해 주세요.", refresh: "dashboard" };
  }
}

export function adminSettingsMutationFeedback(input: {
  readonly notifications: AdminMutationResult<unknown>;
  readonly periods: AdminMutationResult<unknown>;
}): AdminSettingsMutationFeedbackDecision {
  return {
    message: adminSettingsSaveMessage(input),
    refreshNotifications: input.notifications.kind === "ok",
    refreshPeriods: input.periods.kind === "ok"
  };
}

function reconciliationSuccessMessage(action: AdminNotificationReconciliationAction): string {
  switch (action) {
    case "abandon":
      return "알림 확인을 종료했습니다.";
    case "confirm_sent":
      return "전송 완료로 처리했습니다.";
    case "retry":
      return "마감 명단을 다시 전송했습니다.";
  }
}
