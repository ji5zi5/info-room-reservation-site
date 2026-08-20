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
  return `sha256:${createHash("sha256").update("discord-operations-board:v1\0").update(JSON.stringify(snapshot)).digest("hex")}`;
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
        button("새로고침", buildDiscordOperationsBoardCustomId({ action: "refresh", revision: input.revision, secret: input.secret })),
        button("8면학 명단", buildDiscordOperationsBoardCustomId({ action: "roster_eighth", revision: input.revision, secret: input.secret })),
        button("1면학 명단", buildDiscordOperationsBoardCustomId({ action: "roster_first", revision: input.revision, secret: input.secret })),
        button("미처리 작업", buildDiscordOperationsBoardCustomId({ action: "backlog", revision: input.revision, secret: input.secret }))
      ],
      type: 1
    }],
    embeds: [{
      color: 0x5865f2,
      description: [
        `기준 ${formatKstDateTime(input.observedAt)}`,
        `신청 알림 ${enabledLabel(input.snapshot.reservationNotificationsEnabled)} · 마감 명단 ${enabledLabel(input.snapshot.closedNotificationsEnabled)}`,
        `최근 처리 ${nullableDateTime(input.snapshot.lastProcessedAt)} · 최근 오류 ${input.snapshot.recentErrorCount}건`
      ].join("\n"),
      fields: [
        ...input.snapshot.periods.map((period) => ({
          inline: false,
          name: `${period.label} · ${windowLabel(period.windowState)}`,
          value: [
            `${period.openTime}~${period.closeTime} · ${period.confirmedCount}/${period.capacity}명 · 잔여 ${period.remaining}석`,
            `마감 명단 ${deliveryLabel(period.closedListStatus)} · 마지막 ${nullableDateTime(period.closedListProcessedAt)}`,
            period.applicants.length === 0
              ? "신청자 없음"
              : period.applicants.map((applicant, index) => `${index + 1}. ${applicant.studentNumber} ${applicant.name}`).join("\n")
          ].join("\n")
        })),
        {
          inline: false,
          name: "운영 작업",
          value: input.snapshot.operationalJobs.length === 0
            ? "실행 기록 없음"
            : input.snapshot.operationalJobs.map((job) => `${job.job} · ${job.status} · 대기 ${job.backlogCount}`).join("\n")
        },
        {
          inline: false,
          name: "확인 필요",
          value: `관리자 명령 ${input.snapshot.adminCommandBacklog} · 예약 상호작용 ${input.snapshot.interactionBacklog} · 알림 ${input.snapshot.unresolvedDeliveries}`
        }
      ],
      title: `정보실 운영판 · ${input.snapshot.date}`
    }]
  };
}

function button(label: string, customId: string) {
  return { custom_id: customId, label, style: 2, type: 2 } as const;
}

function enabledLabel(enabled: boolean): string {
  return enabled ? "사용" : "중지";
}

function windowLabel(state: string): string {
  switch (state) {
    case "open": return "신청 중";
    case "not_open_yet": return "오픈 전";
    case "closed": return "마감";
    default: return state;
  }
}

function deliveryLabel(status: string): string {
  switch (status) {
    case "SENT": return "전송 완료";
    case "FAILED": return "전송 실패";
    case "UNKNOWN": return "확인 필요";
    case "PENDING":
    case "SENDING": return "대기 중";
    default: return "미전송";
  }
}

function formatKstDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(date);
}

function nullableDateTime(value: string | null): string {
  return value === null ? "없음" : formatKstDateTime(new Date(value));
}
