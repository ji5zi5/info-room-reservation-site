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
        onReconcileNotification: vi.fn(),
        onSendNotification: vi.fn(),
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
