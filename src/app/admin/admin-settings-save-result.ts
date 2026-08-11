import type { AdminMutationResult } from "./admin-api-client";

export type AdminSettingsSaveResult = {
  readonly notifications: AdminMutationResult<unknown>;
  readonly periods: AdminMutationResult<unknown>;
};

export function adminSettingsSaveMessage(result: AdminSettingsSaveResult): string {
  if (result.periods.kind === "ok") {
    if (result.notifications.kind === "ok") {
      return "설정이 저장되었습니다.";
    }
    return `시간대는 저장되었습니다. 디스코드: ${mutationErrorMessage(result.notifications)}`;
  }
  if (result.notifications.kind === "ok") {
    return `디스코드 알림은 저장되었습니다. 시간대: ${mutationErrorMessage(result.periods)}`;
  }
  return `시간대: ${mutationErrorMessage(result.periods)} 디스코드: ${mutationErrorMessage(result.notifications)}`;
}

export function mutationErrorMessage(result: Extract<AdminMutationResult<unknown>, { readonly kind: "error" }>): string {
  if (result.retryAfterMs === null) {
    return result.message;
  }
  return `${result.message} ${Math.ceil(result.retryAfterMs / 1_000)}초 후 다시 시도해 주세요.`;
}
