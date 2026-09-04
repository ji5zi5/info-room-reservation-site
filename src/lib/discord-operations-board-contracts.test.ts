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
  it("changes the state digest once per minute so the board proves it is still syncing", () => {
    // Given: one board state observed twice in one minute and once in the next minute.
    const firstMinute = new Date("2026-08-20T05:00:01Z");
    const sameMinute = new Date("2026-08-20T05:00:59Z");
    const nextMinute = new Date("2026-08-20T05:01:00Z");

    // When: render digests are calculated.
    const digest = discordOperationsBoardStateDigest(snapshot, firstMinute);

    // Then: duplicate ticks in one minute are stable, while the next minute forces a visible heartbeat.
    expect(digest).toBe(discordOperationsBoardStateDigest(snapshot, sameMinute));
    expect(digest).not.toBe(discordOperationsBoardStateDigest(snapshot, nextMinute));
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
    expect(rendered).toContain("마지막 동기화 14:00");
    expect(rendered).toContain("최근 업무 처리 8월 20일 13:59");
    expect(rendered).toContain("8면학 · 운영 중지");
    expect(rendered).toContain("신청 1명 / 10명 · 9자리 남음");
    expect(rendered).toContain("운영 중지로 명단 전송 안 함");
    expect(rendered).not.toContain("마감 후 명단 자동 전송");
    expect(rendered).toContain("관리자 명령 처리 · 정상");
    expect(rendered).toContain("예약 버튼 처리 · 처리 중 · 대기 2건");
    expect(rendered).toContain("마감 명단 전송 · 오류");
    expect(rendered).toContain("관리자 요청 1건 · 예약 버튼 2건 · 마감 명단 3건");
    expect(rendered).toContain("최근 24시간 오류 2건");
    expect(rendered).not.toContain("DISCORD_ADMIN_CONSOLE");
    expect(rendered).not.toContain("DISCORD_INTERACTIONS");
    expect(rendered).not.toContain("CLOSED_PERIOD_NOTIFICATIONS");
    expect(rendered).not.toContain("SUCCEEDED");
    expect(rendered).not.toContain("RUNNING");
    expect(rendered).not.toContain("FAILED");
    expect(rendered).not.toContain("closed-period:");
    expect(payload.components?.[0]?.components[0]).toMatchObject({ label: "현황 새로고침", style: 1 });
    expect(payload.components?.[0]?.components[3]).toMatchObject({ label: "확인할 작업 6건" });
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

    expect(rendered).toContain("자동 처리 정상 · 확인할 작업 없음");
    expect(rendered).not.toContain("관리자 명령 처리");
    expect(rendered).not.toContain("DISCORD_ADMIN_CONSOLE");
    expect(rendered).not.toContain("RUNNING");
  });

  it.each([
    ["before close", true, "NOT_SENT", "open", "마감 후 명단 자동 전송 예정"],
    ["after close", true, "NOT_SENT", "closed", "마감 명단 전송 대기"],
    ["notifications disabled", false, "NOT_SENT", "open", "마감 명단 알림 꺼짐"],
    ["sent", true, "SENT", "closed", "마감 명단 전송 완료"],
    ["failed", true, "FAILED", "closed", "마감 명단 전송 실패"],
    ["remote result uncertain", true, "UNKNOWN", "closed", "마감 명단 전송 여부 확인 필요"],
    ["manual review", true, "PENDING_REVIEW", "closed", "마감 명단 전송 여부 확인 필요"],
    ["abandoned", true, "ABANDONED", "closed", "마감 명단 처리 종료"]
  ] as const)("renders an actionable closed-list state when %s", (
    _case,
    closedNotificationsEnabled,
    closedListStatus,
    windowState,
    expected
  ) => {
    // Given: a period in one closed-list delivery state.
    const payload = buildDiscordOperationsBoardPayload({
      observedAt: new Date("2026-08-20T05:00:00Z"),
      revision: 1,
      secret: "secret",
      snapshot: {
        ...snapshot,
        closedNotificationsEnabled,
        periods: [period({ closedListStatus, windowState })]
      }
    });

    // When: the period field is rendered.
    const rendered = JSON.stringify(payload);

    // Then: the operator sees the real state rather than a generic future promise.
    expect(rendered).toContain(expected);
  });

  it("collapses an empty applicant section to one readable line", () => {
    const payload = buildDiscordOperationsBoardPayload({
      observedAt: new Date("2026-08-20T05:00:00Z"),
      revision: 1,
      secret: "secret",
      snapshot: { ...snapshot, periods: [period()] }
    });
    const rendered = JSON.stringify(payload);

    expect(rendered).toContain("신청자 없음");
    expect(rendered).not.toContain("신청자\\n없음");
  });
});

function period(
  overrides: Partial<DiscordOperationsBoardSnapshot["periods"][number]> = {}
): DiscordOperationsBoardSnapshot["periods"][number] {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "17:00",
    closedListProcessedAt: null,
    closedListStatus: "NOT_SENT",
    confirmedCount: 0,
    date: "2026-08-20",
    enabled: true,
    label: "8면학",
    myReservationId: null,
    openTime: "13:00",
    remaining: 10,
    studyPeriod: "EIGHTH",
    windowState: "open",
    ...overrides
  };
}
