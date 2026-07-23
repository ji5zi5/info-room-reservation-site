import { STUDY_PERIODS, type StudyPeriod } from "./study-periods";
import type { NotificationSettings } from "./notification-settings";
import type {
  ClosedPeriodNotificationReconciliationAction,
  ReconcileClosedPeriodResult
} from "./closed-period-notification-service";

export type PeriodSettingsAuditRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: string;
};

export type AdminOperationActionData = {
  readonly action:
    | "CLOSED_LIST_NOTIFICATION_RECONCILE"
    | "CLOSED_LIST_NOTIFICATION_SEND"
    | "NOTIFICATION_SETTINGS_PATCH"
    | "PERIOD_SETTINGS_PATCH";
  readonly actorId: string;
  readonly after: string;
  readonly before: string | null;
  readonly ipHash: string;
  readonly reason: string;
};

type ClosedListNotificationAuditResult = {
  readonly delivery: {
    readonly lastError?: string | null;
    readonly messageIds?: readonly string[];
    readonly status: "FAILED" | "SENT" | "UNKNOWN";
  };
  readonly kind: "failed" | "sent" | "unknown";
};

type SuccessfulClosedListReconciliation = Exclude<ReconcileClosedPeriodResult, { readonly kind: "conflict" }>;

type NotificationSettingsAuditSnapshot = {
  readonly closedPeriodNotificationsEnabled: boolean;
  readonly reservationCreatedNotificationsEnabled: boolean;
};

export function buildPeriodSettingsPatchAdminAction(input: {
  readonly actorId: string;
  readonly after: readonly PeriodSettingsAuditRow[];
  readonly before: readonly PeriodSettingsAuditRow[];
  readonly date: string;
  readonly ipHash: string;
}): AdminOperationActionData {
  return {
    action: "PERIOD_SETTINGS_PATCH",
    actorId: input.actorId,
    after: JSON.stringify({ date: input.date, periods: summarizePeriodSettingsForAudit(input.after) }),
    before: JSON.stringify({ date: input.date, periods: summarizePeriodSettingsForAudit(input.before) }),
    ipHash: input.ipHash,
    reason: "시간대 설정 변경"
  };
}

export function buildClosedListNotificationAdminAction(input: {
  readonly actorId: string;
  readonly date: string;
  readonly force: boolean;
  readonly ipHash: string;
  readonly result: ClosedListNotificationAuditResult;
  readonly studyPeriod: StudyPeriod;
}): AdminOperationActionData {
  return {
    action: "CLOSED_LIST_NOTIFICATION_SEND",
    actorId: input.actorId,
    after: JSON.stringify({
      date: input.date,
      force: input.force,
      kind: input.result.kind,
      lastError: input.result.delivery.lastError ?? null,
      messageIds: input.result.delivery.messageIds ?? [],
      status: input.result.delivery.status,
      studyPeriod: input.studyPeriod
    }),
    before: null,
    ipHash: input.ipHash,
    reason: input.force ? "마감 명단 재전송" : "마감 명단 수동 전송"
  };
}

export function buildClosedListNotificationReconciliationAdminAction(input: {
  readonly actorId: string;
  readonly date: string;
  readonly ipHash: string;
  readonly operation: ClosedPeriodNotificationReconciliationAction;
  readonly result: SuccessfulClosedListReconciliation;
  readonly studyPeriod: StudyPeriod;
}): AdminOperationActionData {
  return {
    action: "CLOSED_LIST_NOTIFICATION_RECONCILE",
    actorId: input.actorId,
    after: JSON.stringify({
      date: input.date,
      kind: input.result.kind,
      operation: input.operation,
      status: input.result.delivery.status,
      studyPeriod: input.studyPeriod
    }),
    before: JSON.stringify({
      date: input.date,
      status: input.result.previousStatus,
      studyPeriod: input.studyPeriod
    }),
    ipHash: input.ipHash,
    reason: reconciliationReason(input.operation)
  };
}

export function buildNotificationSettingsPatchAdminAction(input: {
  readonly actorId: string;
  readonly after: NotificationSettings;
  readonly before: NotificationSettings;
  readonly ipHash: string;
}): AdminOperationActionData {
  return {
    action: "NOTIFICATION_SETTINGS_PATCH",
    actorId: input.actorId,
    after: JSON.stringify(summarizeNotificationSettingsForAudit(input.after)),
    before: JSON.stringify(summarizeNotificationSettingsForAudit(input.before)),
    ipHash: input.ipHash,
    reason: "알림 설정 변경"
  };
}

export function summarizePeriodSettingsForAudit(
  settings: readonly PeriodSettingsAuditRow[]
): readonly PeriodSettingsAuditRow[] {
  return [...settings].sort((left, right) => periodRank(left.studyPeriod) - periodRank(right.studyPeriod));
}

export function summarizeNotificationSettingsForAudit(
  settings: NotificationSettings
): NotificationSettingsAuditSnapshot {
  return {
    closedPeriodNotificationsEnabled: settings.closedPeriodNotificationsEnabled,
    reservationCreatedNotificationsEnabled: settings.reservationCreatedNotificationsEnabled
  };
}

function periodRank(studyPeriod: string): number {
  const index = STUDY_PERIODS.findIndex((period) => period === studyPeriod);
  return index === -1 ? STUDY_PERIODS.length : index;
}

function reconciliationReason(operation: ClosedPeriodNotificationReconciliationAction): string {
  switch (operation) {
    case "abandon":
      return "마감 명단 알림 확인 종료";
    case "confirm_sent":
      return "마감 명단 전송 완료 확인";
    case "retry":
      return "마감 명단 명시 재시도";
  }
}
