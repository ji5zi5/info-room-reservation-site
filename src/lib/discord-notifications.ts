import ky from "ky";

import { parseDiscordWebhookUrl } from "./discord-webhook-url";
import { getStudyPeriodLabel, type StudyPeriod } from "./study-periods";

const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_SAFE_FIELD_VALUE_LIMIT = 900;
const DISCORD_WEBHOOK_URL_PATTERN =
  /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+)\/[^\s"')<>]+/gu;

export type ClosedPeriodNotificationApplicant = {
  readonly name: string;
  readonly reason: string | null;
  readonly studentNumber: string;
};

export type ClosedPeriodNotificationInput = {
  readonly applicants: readonly ClosedPeriodNotificationApplicant[];
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly studyPeriod: StudyPeriod;
};

export type ReservationCreatedNotificationInput = {
  readonly date: string;
  readonly reason: string | null;
  readonly studentName: string;
  readonly studentNumber: string;
  readonly studyPeriod: StudyPeriod;
};

export type DiscordWebhookPayload = {
  readonly allowed_mentions: {
    readonly parse: readonly string[];
  };
  readonly embeds: readonly DiscordEmbed[];
  readonly username: string;
};

type DiscordEmbed = {
  readonly color: number;
  readonly description: string;
  readonly fields: readonly DiscordEmbedField[];
  readonly title: string;
};

type DiscordEmbedField = {
  readonly inline: boolean;
  readonly name: string;
  readonly value: string;
};

type DiscordWebhookMessage = {
  readonly id?: string;
};

export type DiscordWebhookSendResult = {
  readonly messageIds: readonly string[];
};

export function buildClosedPeriodDiscordPayload(input: ClosedPeriodNotificationInput): DiscordWebhookPayload {
  const label = getStudyPeriodLabel(input.studyPeriod);
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: 0xe82127,
        description: `${input.date} · ${input.closeTime} 마감 · ${input.confirmedCount}/${input.capacity}명`,
        fields: buildApplicantFields(input.applicants),
        title: `${label} 마감 신청자 명단`
      }
    ],
    username: "정보실 예약"
  };
}

export function buildReservationCreatedDiscordPayload(
  input: ReservationCreatedNotificationInput
): DiscordWebhookPayload {
  const label = getStudyPeriodLabel(input.studyPeriod);
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: 0x1f6feb,
        description: `${input.date} · ${label}`,
        fields: [
          {
            inline: true,
            name: "학생",
            value: `${input.studentName} (${input.studentNumber})`
          },
          {
            inline: false,
            name: "사유",
            value: reservationReasonLabel(input.reason)
          }
        ],
        title: "신청 알림"
      }
    ],
    username: "정보실 예약"
  };
}

export function buildDiscordWebhookExecuteUrl(webhookUrl: string): string {
  const url = parseDiscordWebhookUrl(webhookUrl);
  url.searchParams.set("wait", "true");
  return url.toString();
}

export async function sendDiscordWebhook(input: {
  readonly payload: DiscordWebhookPayload;
  readonly webhookUrl: string;
}): Promise<DiscordWebhookSendResult> {
  const message = await ky
    .post(buildDiscordWebhookExecuteUrl(input.webhookUrl), {
      json: input.payload,
      retry: { limit: 1 },
      timeout: 10_000
    })
    .json<DiscordWebhookMessage>();
  return { messageIds: message.id ? [message.id] : [] };
}

export function redactDiscordWebhookTokens(message: string): string {
  return message.replace(DISCORD_WEBHOOK_URL_PATTERN, "$1/[redacted]");
}

function buildApplicantFields(applicants: readonly ClosedPeriodNotificationApplicant[]): readonly DiscordEmbedField[] {
  if (applicants.length === 0) {
    return [{ inline: false, name: "신청자", value: "신청자 없음" }];
  }

  const chunks = chunkApplicantLines(applicants.map(formatApplicantLine));
  return chunks.map((chunk, index) => ({
    inline: false,
    name: index === 0 ? "신청자" : "신청자 계속",
    value: chunk
  }));
}

function formatApplicantLine(applicant: ClosedPeriodNotificationApplicant, index: number): string {
  return `${index + 1}. ${applicant.name} (${applicant.studentNumber}) - ${reservationReasonLabel(applicant.reason)}`;
}

function reservationReasonLabel(reason: string | null): string {
  const normalized = reason?.trim();
  return normalized ? normalized : "사유 미기록";
}

function chunkApplicantLines(lines: readonly string[]): readonly string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > DISCORD_SAFE_FIELD_VALUE_LIMIT && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((chunk) => chunk.slice(0, DISCORD_FIELD_VALUE_LIMIT));
}
