"use client";

import { AlertTriangle, ClipboardList, Send, TrendingUp, Users } from "lucide-react";

import { isStaleSendingDelivery } from "@/lib/closed-period-notifications";

import type { AdminDashboardPeriod, AdminStatistics } from "./admin-types";
import { buildStatisticsCsv } from "./admin-csv";

export function AdminDashboardPanel({
  onSendNotification,
  periods,
  statistics
}: {
  readonly onSendNotification: (period: AdminDashboardPeriod, force: boolean) => void;
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
          <span>
            <Users size={16} />
            {statistics.totals.uniqueStudentCount}명
          </span>
        </div>
      ) : null}
      <div className="admin-dashboard-grid">
        {periods.map((period) => (
          <article className="metric-card" key={period.studyPeriod}>
            <div className="period-top">
              <h3>{period.label}</h3>
              <span className="period-badge">{period.isClosed ? "마감됨" : "진행 전/진행 중"}</span>
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
              <button
                className={period.notification?.status === "SENT" ? "ghost-button" : "primary-button"}
                disabled={!period.isClosed || isFreshSendingNotification(period)}
                type="button"
                onClick={() => onSendNotification(period, shouldForceNotification(period))}
              >
                <Send size={16} />
                {notificationActionLabel(period)}
              </button>
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
            <h3>반복 취소 · 노쇼</h3>
            <AlertTriangle size={18} />
          </div>
          {statistics.repeatedOffenders.length === 0 ? (
            <p className="muted">반복 기록 없음</p>
          ) : (
            <div className="detail-lines">
              {statistics.repeatedOffenders.map((offender) => (
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

function isFreshSendingNotification(period: AdminDashboardPeriod): boolean {
  const notification = period.notification;
  if (notification?.status !== "SENDING") {
    return false;
  }
  return !isStaleSendingDelivery({ status: notification.status, updatedAt: new Date(notification.updatedAt) }, new Date());
}

function isStaleSendingNotification(period: AdminDashboardPeriod): boolean {
  const notification = period.notification;
  return notification?.status === "SENDING" && !isFreshSendingNotification(period);
}

function notificationActionLabel(period: AdminDashboardPeriod): string {
  if (isFreshSendingNotification(period)) {
    return "전송 중";
  }
  if (period.notification?.status === "SENT" || isStaleSendingNotification(period)) {
    return "재전송";
  }
  return "마감 명단 보내기";
}

function shouldForceNotification(period: AdminDashboardPeriod): boolean {
  return period.notification?.status === "SENT" || isStaleSendingNotification(period);
}

function notificationLabel(period: AdminDashboardPeriod): string {
  if (!period.notification) {
    return "전송 대기";
  }
  switch (period.notification.status) {
    case "FAILED":
      return `전송 실패 · ${period.notification.attempts}회`;
    case "SENDING":
      return `전송 중 · ${period.notification.attempts}회`;
    case "SENT":
      return `전송됨 · ${period.notification.messageIds.length}건`;
  }
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
