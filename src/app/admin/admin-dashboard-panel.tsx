"use client";

import {
  AlertTriangle,
  Check,
  ClipboardList,
  RotateCcw,
  Send,
  TrendingUp,
  Users,
  X
} from "lucide-react";

import type {
  AdminDashboardPeriod,
  AdminNotificationBacklogItem,
  AdminNotificationReconciliationAction,
  AdminOperationItem,
  AdminOperationRepairAction,
  AdminOperationsPayload,
  AdminStatistics
} from "./admin-types";
import type { AdminMutationResult } from "./admin-api-client";
import type { AdminConsoleDeepLinkTarget } from "./admin-console-url";
import { AdminOperationsPanel } from "./admin-operations-panel";
import { buildStatisticsCsv } from "./admin-csv";

export function AdminDashboardPanel({
  notificationBacklog,
  onNavigateOperationTarget,
  onRepairOperation,
  onReconcileNotification,
  onSendNotification,
  operations,
  periods,
  statistics
}: {
  readonly notificationBacklog: readonly AdminNotificationBacklogItem[];
  readonly onNavigateOperationTarget: (target: AdminConsoleDeepLinkTarget) => void;
  readonly onReconcileNotification: (
    item: AdminNotificationBacklogItem,
    action: AdminNotificationReconciliationAction
  ) => void;
  readonly onSendNotification: (period: AdminDashboardPeriod) => void;
  readonly onRepairOperation: (item: AdminOperationItem, action: AdminOperationRepairAction) => Promise<AdminMutationResult<unknown>>;
  readonly operations: AdminOperationsPayload | null;
  readonly periods: readonly AdminDashboardPeriod[];
  readonly statistics: AdminStatistics | null;
}): React.ReactElement {
  async function copyStatisticsCsv(): Promise<void> {
    if (statistics) {
      await navigator.clipboard.writeText(buildStatisticsCsv(statistics));
    }
  }

  return (
    <section className="admin-panel stack">
      <div className="topbar admin-dashboard-topbar">
        <div>
          <h2>운영 대시보드</h2>
        </div>
        <div className="admin-action-row">
          {statistics ? (
            <button className="ghost-button" type="button" onClick={() => void copyStatisticsCsv()}>
              <ClipboardList size={18} />
              통계 복사
            </button>
          ) : null}
        </div>
      </div>
      {statistics ? (
        <div className="admin-stat-strip" aria-label="운영 통계">
          <span>
            <TrendingUp size={16} />
            총 {statistics.totals.totalCount}건
          </span>
          <span>확정 {statistics.totals.confirmedCount}건</span>
          <span>취소 {statistics.totals.cancelledCount}건</span>
          <span>노쇼 {statistics.totals.noShowCount}건</span>
          <span>최근 최대 100건 기준</span>
          <span>
            <Users size={16} />
            {statistics.totals.uniqueStudentCount}명
          </span>
        </div>
      ) : null}
      {operations ? (
        <AdminOperationsPanel
          operations={operations}
          onNavigate={onNavigateOperationTarget}
          onRepair={onRepairOperation}
        />
      ) : null}
      {notificationBacklog.length > 0 ? (
        <section className="admin-notification-review" aria-label="확인이 필요한 Discord 알림">
          <div className="period-top">
            <h3>알림 확인 필요</h3>
            <span className="period-badge">최근 7일 · 최대 14건</span>
          </div>
          <div className="admin-notification-review-list">
            {notificationBacklog.map((item) => (
              <div
                className="admin-notification-review-row"
                key={`${item.date}-${item.studyPeriod}`}
              >
                <div className="admin-notification-review-summary">
                  <div className="admin-notification-review-heading">
                    <strong>
                      {formatDate(item.date)} · {studyPeriodLabel(item.studyPeriod)}
                    </strong>
                    <span className="notification-pill" data-status={item.status}>
                      {reconciliationStatusLabel(item.status)}
                    </span>
                  </div>
                  {item.lastError ? <span className="muted">{item.lastError}</span> : null}
                </div>
                <div className="admin-notification-review-actions">
                  {item.status === "UNKNOWN" ? (
                    <button
                      className="primary-button detail-line-action"
                      type="button"
                      onClick={() => onReconcileNotification(item, "confirm_sent")}
                    >
                      <Check size={16} />
                      전송됨 처리
                    </button>
                  ) : null}
                  <button
                    className="ghost-button detail-line-action"
                    type="button"
                    onClick={() => onReconcileNotification(item, "retry")}
                  >
                    <RotateCcw size={16} />
                    다시 시도
                  </button>
                  <button
                    className="ghost-button detail-line-action"
                    type="button"
                    onClick={() => onReconcileNotification(item, "abandon")}
                  >
                    <X size={16} />
                    종료
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className="admin-dashboard-grid">
        {periods.map((period) => (
          <article className="metric-card" key={period.studyPeriod}>
            <div className="period-top">
              <h3>{period.label}</h3>
              <span className="period-badge">{periodWindowLabel(period.windowState)}</span>
            </div>
            <div className="metric-grid">
              <span>신청 {period.confirmedCount}명</span>
              <span>남은 자리 {period.remaining}석</span>
              <span>{period.openTime} - {period.closeTime}</span>
            </div>
            <div className="notice-panel">
              <span className="notification-pill" data-status={period.notification?.status ?? "WAITING"}>
                {notificationLabel(period)}
              </span>
              {period.notification?.sentAt ? <p className="muted">마지막 전송 {formatKst(period.notification.sentAt)}</p> : null}
              {period.notification?.lastError ? <p className="muted">실패 원인 {period.notification.lastError}</p> : null}
              {shouldOfferManualSend(period) ? (
                <button
                  className="primary-button"
                  disabled={!period.isClosed}
                  type="button"
                  onClick={() => onSendNotification(period)}
                >
                  <Send size={16} />
                  마감 명단 보내기
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {statistics ? (
        <div className="admin-stat-grid">
          {statistics.periodStats.map((period) => (
            <article className="stat-summary-card" key={period.studyPeriod}>
              <div>
                <h3>{period.label}</h3>
                <p className="muted">채움률 {period.fillRate}%</p>
              </div>
              <div className="stat-mini-grid">
                <span>정원 {period.capacity}</span>
                <span>확정 {period.confirmedCount}</span>
                <span>취소 {period.cancelledCount}</span>
                <span>노쇼 {period.noShowCount}</span>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {statistics ? (
        <section className="admin-offender-panel" aria-label="반복 취소 및 노쇼 학생">
          <div className="period-top">
            <h3>반복 취소 · 노쇼 · 반복 기록 상위 10명</h3>
            <AlertTriangle size={18} />
          </div>
          {statistics.repeatedOffenders.length === 0 ? (
            <p className="muted">반복 기록 없음</p>
          ) : (
            <div className="detail-lines">
              {statistics.repeatedOffenders.slice(0, 10).map((offender) => (
                <div className="detail-line" key={offender.userId}>
                  <span>
                    {offender.name} ({offender.studentNumber})
                  </span>
                  <strong>
                    총 {offender.totalIncidents}회 · 취소 {offender.cancelledCount} · 노쇼 {offender.noShowCount}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}

function shouldOfferManualSend(period: AdminDashboardPeriod): boolean {
  return period.notification === null || period.notification.status === "PENDING";
}

function periodWindowLabel(windowState: AdminDashboardPeriod["windowState"]): string {
  return windowState === "not_open_yet" ? "오픈 전" : windowState === "open" ? "진행 중" : "마감됨";
}

function notificationLabel(period: AdminDashboardPeriod): string {
  if (!period.notification) {
    return "전송 대기";
  }
  switch (period.notification.status) {
    case "ABANDONED":
      return "확인 종료";
    case "FAILED":
      return `전송 실패 · ${period.notification.attempts}회`;
    case "PENDING":
      return "전송 대기";
    case "PENDING_REVIEW":
      return "확인 대기";
    case "SENDING":
      return `전송 중 · ${period.notification.attempts}회`;
    case "SENT":
      return "전송됨";
    case "UNKNOWN":
      return "결과 확인 필요";
  }
}

function reconciliationStatusLabel(status: AdminNotificationBacklogItem["status"]): string {
  switch (status) {
    case "FAILED":
      return "전송 실패";
    case "PENDING_REVIEW":
      return "확인 대기";
    case "UNKNOWN":
      return "결과 확인 필요";
  }
}

function studyPeriodLabel(studyPeriod: AdminNotificationBacklogItem["studyPeriod"]): string {
  return studyPeriod === "EIGHTH" ? "8면학" : "1면학";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Seoul"
  }).format(new Date(`${value}T00:00:00+09:00`));
}

function formatKst(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    day: "2-digit"
  }).format(new Date(value));
}
