import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdminDashboardPanel } from "./admin-dashboard-panel";
import type { AdminDashboardPeriod, AdminNotificationBacklogItem } from "./admin-types";

describe("AdminDashboardPanel notification reconciliation", () => {
  it("renders explicit actions for an unknown delivery and no ordinary resend for sent periods", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminDashboardPanel, {
        notificationBacklog: [unknownDelivery],
        onNavigateOperationTarget: vi.fn(),
        onReconcileNotification: vi.fn(),
        onRepairOperation: vi.fn(),
        onSendNotification: vi.fn(),
        operations: null,
        periods: [sentPeriod],
        statistics: null
      })
    );

    expect(markup).toContain("알림 확인 필요");
    expect(markup).toContain("전송됨 처리");
    expect(markup).toContain("다시 시도");
    expect(markup).toContain("종료");
    expect(markup).not.toContain("재전송");
  });

  it("shows distinct labels for periods before opening, open, and closed", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminDashboardPanel, {
        notificationBacklog: [],
        onNavigateOperationTarget: vi.fn(),
        onReconcileNotification: vi.fn(),
        onRepairOperation: vi.fn(),
        onSendNotification: vi.fn(),
        operations: null,
        periods: [
          { ...sentPeriod, isClosed: false, notification: null, windowState: "not_open_yet" },
          { ...sentPeriod, isClosed: false, notification: null, windowState: "open" },
          sentPeriod
        ],
        statistics: null
      })
    );

    expect(markup).toContain("오픈 전");
    expect(markup).toContain("진행 중");
    expect(markup).toContain("마감됨");
    expect(markup).not.toContain("진행 전/진행 중");
  });

  it("discloses the bounded reconciliation, offender, and reservation-metric sources", () => {
    const statistics = {
      dailyStats: [],
      from: "2026-06-01",
      periodStats: [],
      repeatedOffenders: Array.from({ length: 11 }, (_, index) => ({
        cancelledCount: 1,
        name: `반복 학생 ${index}`,
        noShowCount: 1,
        studentNumber: `320${index}`,
        totalIncidents: 2,
        userId: `offender-${index}`
      })),
      to: "2026-06-16",
      totals: { cancelledCount: 1, confirmedCount: 1, noShowCount: 1, totalCount: 3, uniqueStudentCount: 2 }
    };
    const markup = renderToStaticMarkup(
      createElement(AdminDashboardPanel, {
        notificationBacklog: Array.from({ length: 14 }, (_, index) => ({
          ...unknownDelivery,
          date: `2026-06-${String(index + 1).padStart(2, "0")}`
        })),
        onNavigateOperationTarget: vi.fn(),
        onReconcileNotification: vi.fn(),
        onRepairOperation: vi.fn(),
        onSendNotification: vi.fn(),
        operations: null,
        periods: [sentPeriod],
        statistics
      })
    );

    expect(markup).toContain("최근 7일 · 최대 14건");
    expect(markup).toContain("반복 기록 상위 10명");
    expect(markup).toContain("최근 최대 100건 기준");
    expect(markup).toContain("반복 학생 9");
    expect(markup).not.toContain("반복 학생 10");
  });
});

const sentPeriod = {
  applicants: [],
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 3,
  date: "2026-06-12",
  enabled: true,
  isClosed: true,
  label: "8면학",
  notification: {
    attempts: 1,
    lastError: null,
    messageIds: ["discord-message-1"],
    sentAt: "2026-06-12T07:25:00.000Z",
    status: "SENT",
    updatedAt: "2026-06-12T07:25:00.000Z"
  },
  openTime: "13:00",
  remaining: 7,
  studyPeriod: "EIGHTH",
  windowState: "closed"
} satisfies AdminDashboardPeriod;

const unknownDelivery: AdminNotificationBacklogItem = {
  attempts: 1,
  date: "2026-06-12",
  failureCode: "discord_timeout",
  lastError: "Discord response timed out",
  nextAttemptAt: null,
  status: "UNKNOWN",
  studyPeriod: "EIGHTH",
  updatedAt: "2026-06-12T07:25:00.000Z"
};
