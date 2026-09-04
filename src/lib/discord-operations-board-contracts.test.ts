import { describe, expect, it } from "vitest";

import {
  buildDiscordOperationsBoardPayload,
  discordOperationsBoardStateDigest,
  type DiscordOperationsBoardSnapshot
} from "./discord-operations-board-contracts";

const snapshot: DiscordOperationsBoardSnapshot = {
  adminCommandBacklog: 0,
  closedNotificationsEnabled: true,
  date: "2026-08-20",
  interactionBacklog: 0,
  lastProcessedAt: "2026-08-20T04:59:00.000Z",
  operationalJobs: [],
  periods: [],
  reservationNotificationsEnabled: true,
  recentErrorCount: 0,
  unresolvedDeliveries: 0
};

describe("Discord operations board contracts", () => {
  it("keeps the state digest stable when only the observation time changes", () => {
    // Given: one board state observed at different times.
    const first = buildDiscordOperationsBoardPayload({ observedAt: new Date("2026-08-20T05:00:00Z"), revision: 1, secret: "secret", snapshot });
    const second = buildDiscordOperationsBoardPayload({ observedAt: new Date("2026-08-20T05:01:00Z"), revision: 1, secret: "secret", snapshot });

    // When: the state digest and rendered payloads are compared.
    const digest = discordOperationsBoardStateDigest(snapshot);

    // Then: time can change without forcing a board edit, while the rendered basis time remains available.
    expect(digest).toBe(discordOperationsBoardStateDigest({ ...snapshot }));
    expect(first).not.toEqual(second);
  });

  it("renders the last processing time and recent error count without exposing internal IDs", () => {
    const payload = buildDiscordOperationsBoardPayload({
      observedAt: new Date("2026-08-20T05:00:00Z"),
      revision: 1,
      secret: "secret",
      snapshot: {
        ...snapshot,
        adminCommandBacklog: 1,
        interactionBacklog: 2,
        operationalJobs: [
          { backlogCount: 0, job: "DISCORD_ADMIN_CONSOLE", status: "SUCCEEDED" },
          { backlogCount: 2, job: "DISCORD_INTERACTIONS", status: "RUNNING" },
          { backlogCount: 0, job: "CLOSED_PERIOD_NOTIFICATIONS", status: "FAILED" }
        ],
        periods: [{
          applicants: [{ name: "엄지오", reservationId: "reservation-1", studentNumber: "2414" }],
          capacity: 10,
          closeTime: "17:00",
          closedListProcessedAt: null,
          closedListStatus: "NOT_SENT",
          confirmedCount: 1,
          date: "2026-08-20",
          enabled: false,
          label: "8면학",
          myReservationId: null,
          openTime: "13:00",
          remaining: 9,
          studyPeriod: "EIGHTH",
          windowState: "open"
        }],
        recentErrorCount: 2,
        unresolvedDeliveries: 3
      }
    });
    const rendered = JSON.stringify(payload);

    expect(rendered).toContain("정보실 예약 현황");
    expect(rendered).toContain("8월 20일 목요일");
    expect(rendered).toContain("8면학 · 운영 중지");
    expect(rendered).toContain("신청 1명 / 10명 · 9자리 남음");
    expect(rendered).toContain("운영 중지로 명단 전송 안 함");
    expect(rendered).not.toContain("마감 후 명단 자동 전송");
    expect(rendered).toContain("관리자 명령 처리 · 정상");
    expect(rendered).toContain("예약 버튼 처리 · 처리 중 · 대기 2건");
    expect(rendered).toContain("마감 명단 전송 · 오류");
    expect(rendered).toContain("관리자 요청 1건 · 예약 버튼 2건 · 알림 재전송 3건");
    expect(rendered).toContain("최근 24시간 오류 2건");
    expect(rendered).not.toContain("DISCORD_ADMIN_CONSOLE");
    expect(rendered).not.toContain("DISCORD_INTERACTIONS");
    expect(rendered).not.toContain("CLOSED_PERIOD_NOTIFICATIONS");
    expect(rendered).not.toContain("SUCCEEDED");
    expect(rendered).not.toContain("RUNNING");
    expect(rendered).not.toContain("FAILED");
    expect(rendered).not.toContain("closed-period:");
    expect(payload.components?.[0]?.components[0]).toMatchObject({ label: "현황 새로고침", style: 1 });
  });

  it("keeps routine in-progress work compact when nothing needs attention", () => {
    const payload = buildDiscordOperationsBoardPayload({
      observedAt: new Date("2026-08-20T05:00:00Z"),
      revision: 1,
      secret: "secret",
      snapshot: {
        ...snapshot,
        operationalJobs: [
          { backlogCount: 0, job: "DISCORD_ADMIN_CONSOLE", status: "RUNNING" },
          { backlogCount: 0, job: "MAINTENANCE", status: "SUCCEEDED" }
        ]
      }
    });
    const rendered = JSON.stringify(payload);

    expect(rendered).toContain("자동 처리 정상");
    expect(rendered).toContain("관리자 확인이 필요한 작업 없음");
    expect(rendered).not.toContain("관리자 명령 처리");
    expect(rendered).not.toContain("DISCORD_ADMIN_CONSOLE");
    expect(rendered).not.toContain("RUNNING");
  });
});
