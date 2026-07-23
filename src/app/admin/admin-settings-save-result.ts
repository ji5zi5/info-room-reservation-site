export type AdminSettingsSaveResult = {
  readonly notificationsSaved: boolean;
  readonly periodsSaved: boolean;
};

export function adminSettingsSaveMessage(result: AdminSettingsSaveResult): string {
  if (result.periodsSaved && result.notificationsSaved) {
    return "설정이 저장되었습니다.";
  }
  if (result.periodsSaved) {
    return "시간 설정은 저장됐지만 디스코드 알림 저장에 실패했습니다.";
  }
  if (result.notificationsSaved) {
    return "디스코드 알림은 저장됐지만 시간 설정 저장에 실패했습니다.";
  }
  return "시간 설정과 디스코드 알림 저장에 실패했습니다.";
}
