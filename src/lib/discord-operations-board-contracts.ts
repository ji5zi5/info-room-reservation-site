import { createHash } from "node:crypto";

import type { DiscordBotMessagePayload } from "./discord-bot";
import { buildDiscordOperationsBoardCustomId } from "./discord-admin-custom-ids";
import type { PeriodSummary } from "./period-settings";

export type DiscordOperationsBoardSnapshot = {
  readonly adminCommandBacklog: number;
  readonly closedNotificationsEnabled: boolean;
  readonly date: string;
  readonly interactionBacklog: number;
  readonly lastProcessedAt: string | null;
  readonly operationalJobs: readonly {
    readonly backlogCount: number;
    readonly job: string;
    readonly status: string;
  }[];
  readonly periods: readonly (PeriodSummary & {
    readonly closedListProcessedAt: string | null;
    readonly closedListStatus: string;
  })[];
  readonly recentErrorCount: number;
  readonly reservationNotificationsEnabled: boolean;
  readonly unresolvedDeliveries: number;
};

export function discordOperationsBoardStateDigest(snapshot: DiscordOperationsBoardSnapshot): string {
  return `sha256:${createHash("sha256").update("discord-operations-board:v4\0").update(JSON.stringify(snapshot)).digest("hex")}`;
}

export function buildDiscordOperationsBoardPayload(input: {
  readonly observedAt: Date;
  readonly revision: number;
  readonly secret: string;
  readonly snapshot: DiscordOperationsBoardSnapshot;
}): DiscordBotMessagePayload {
  return {
    allowed_mentions: { parse: [] },
    components: [{
      components: [
        button("현황 새로고침", buildDiscordOperationsBoardCustomId({ action: "refresh", revision: input.revision, secret: input.secret }), 1),
        button("8면학 명단", buildDiscordOperationsBoardCustomId({ action: "roster_eighth", revision: input.revision, secret: input.secret })),
        button("1면학 명단", buildDiscordOperationsBoardCustomId({ action: "roster_first", revision: input.revision, secret: input.secret })),
        button("확인할 작업", buildDiscordOperationsBoardCustomId({ action: "backlog", revision: input.revision, secret: input.secret }))
      ],
      type: 1
    }],
    embeds: [{
      color: 0x3e6ae1,
      description: [
        `**${formatBoardDate(input.snapshot.date)}** · ${formatKstTime(input.observedAt)} 기준`,
        `신청 알림 ${enabledLabel(input.snapshot.reservationNotificationsEnabled)} · 마감 명단 알림 ${enabledLabel(input.snapshot.closedNotificationsEnabled)}`,
        `${lastProcessedLabel(input.snapshot.lastProcessedAt)} · ${recentErrorLabel(input.snapshot.recentErrorCount)}`
      ].join("\n"),
      fields: [
        ...input.snapshot.periods.map((period) => ({
          inline: false,
          name: `${period.label} · ${periodStatusLabel(period.enabled, period.windowState)}`,
          value: [
            `신청 시간 ${period.openTime} - ${period.closeTime}`,
            `신청 ${period.confirmedCount}명 / ${period.capacity}명 · ${remainingLabel(period.remaining)}`,
            closedListLabel(period.enabled, period.closedListStatus, period.closedListProcessedAt),
            "",
            "신청자",
            period.applicants.length === 0
              ? "없음"
              : period.applicants.map((applicant, index) => `${index + 1}. ${applicant.studentNumber} ${applicant.name}`).join("\n")
          ].join("\n")
        })),
        {
          inline: false,
          name: "운영 상태",
          value: operationalStatusLabel(input.snapshot)
        }
      ],
      title: "정보실 예약 현황"
    }]
  };
}

function button(label: string, customId: string, style: 1 | 2 = 2) {
  return { custom_id: customId, label, style, type: 2 } as const;
}

function enabledLabel(enabled: boolean): string {
  return enabled ? "켜짐" : "꺼짐";
}

function periodStatusLabel(enabled: boolean, state: PeriodSummary["windowState"]): string {
  return enabled ? windowLabel(state) : "운영 중지";
}

function windowLabel(state: PeriodSummary["windowState"]): string {
  switch (state) {
    case "open": return "신청 중";
    case "not_open_yet": return "오픈 전";
    case "closed": return "마감";
  }
}

function closedListLabel(enabled: boolean, status: string, processedAt: string | null): string {
  if (!enabled) return "운영 중지로 명단 전송 안 함";
  const processed = processedAt === null ? "" : ` · ${formatKstDateTime(new Date(processedAt))}`;
  switch (status) {
    case "SENT": return `마감 명단 전송 완료${processed}`;
    case "FAILED": return `마감 명단 전송 실패${processed}`;
    case "UNKNOWN": return `마감 명단 확인 필요${processed}`;
    case "PENDING":
    case "SENDING": return "마감 명단 전송 중";
    default: return "마감 후 명단 자동 전송";
  }
}

function remainingLabel(remaining: number): string {
  return remaining === 0 ? "남은 자리 없음" : `${remaining}자리 남음`;
}

function operationalStatusLabel(snapshot: DiscordOperationsBoardSnapshot): string {
  const hasDetailedStatus = snapshot.operationalJobs.some(
    (job) => (job.status !== "SUCCEEDED" && job.status !== "RUNNING") || job.backlogCount > 0
  );
  const jobLines = snapshot.operationalJobs.length === 0
    ? ["자동 작업 실행 기록 없음"]
    : hasDetailedStatus
      ? snapshot.operationalJobs.map((job) => [
          operationalJobLabel(job.job),
          operationalJobStatusLabel(job.status),
          job.backlogCount > 0 ? `대기 ${job.backlogCount}건` : null
        ].filter((part): part is string => part !== null).join(" · "))
      : ["자동 처리 정상"];
  const backlogs = [
    snapshot.adminCommandBacklog > 0 ? `관리자 요청 ${snapshot.adminCommandBacklog}건` : null,
    snapshot.interactionBacklog > 0 ? `예약 버튼 ${snapshot.interactionBacklog}건` : null,
    snapshot.unresolvedDeliveries > 0 ? `알림 재전송 ${snapshot.unresolvedDeliveries}건` : null
  ].filter((part): part is string => part !== null);
  const attention = backlogs.length === 0
    ? "관리자 확인이 필요한 작업 없음"
    : `확인 필요: ${backlogs.join(" · ")}`;
  return [...jobLines, "", attention].join("\n");
}

function operationalJobLabel(job: string): string {
  switch (job) {
    case "CLOSED_PERIOD_NOTIFICATIONS": return "마감 명단 전송";
    case "DISCORD_ADMIN_CONSOLE": return "관리자 명령 처리";
    case "DISCORD_INTERACTIONS": return "예약 버튼 처리";
    case "DISCORD_RESERVATION_OUTBOX": return "예약 알림 전송";
    case "MAINTENANCE": return "일일 정리";
    default: return "기타 자동 작업";
  }
}

function operationalJobStatusLabel(status: string): string {
  switch (status) {
    case "SUCCEEDED": return "정상";
    case "RUNNING": return "처리 중";
    case "FAILED": return "오류";
    default: return "확인 필요";
  }
}

function formatBoardDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) return "날짜 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long"
  }).format(date);
}

function formatKstTime(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(date);
}

function formatKstDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "long",
    timeZone: "Asia/Seoul"
  }).format(date);
}

function lastProcessedLabel(value: string | null): string {
  return value === null ? "최근 처리 기록 없음" : `마지막 처리 ${formatKstDateTime(new Date(value))}`;
}

function recentErrorLabel(count: number): string {
  return count === 0 ? "최근 24시간 오류 없음" : `최근 24시간 오류 ${count}건`;
}
