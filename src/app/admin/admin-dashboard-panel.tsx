"use client";

import { Bell, Send } from "lucide-react";

import type { AdminDashboardPeriod } from "./admin-types";

export function AdminDashboardPanel({
  onSendNotification,
  periods
}: {
  readonly onSendNotification: (period: AdminDashboardPeriod, force: boolean) => void;
  readonly periods: readonly AdminDashboardPeriod[];
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>운영 대시보드</h2>
          <p className="muted">신청 현황 · 마감 상태 · Discord 발송</p>
        </div>
        <Bell aria-hidden="true" size={22} />
      </div>
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
                disabled={!period.isClosed}
                type="button"
                onClick={() => onSendNotification(period, period.notification?.status === "SENT")}
              >
                <Send size={16} />
                {period.notification?.status === "SENT" ? "재전송" : "마감 명단 보내기"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function notificationLabel(period: AdminDashboardPeriod): string {
  if (!period.notification) {
    return "전송 대기";
  }
  switch (period.notification.status) {
    case "FAILED":
      return `전송 실패 · ${period.notification.attempts}회`;
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
