import ky, { HTTPError, isTimeoutError } from "ky";

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
  readonly reservationId: string;
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

export class DiscordWebhookDeliveryError extends Error {
  public readonly code: string;
  public readonly outcome: "FAILED" | "UNKNOWN";
  public readonly retryAt: Date | null;

  public constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly outcome: "FAILED" | "UNKNOWN";
    readonly retryAt?: Date | null;
  }) {
    super(input.message);
    this.code = input.code;
    this.name = "DiscordWebhookDeliveryError";
    this.outcome = input.outcome;
    this.retryAt = input.retryAt ?? null;
  }
}

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
            inline: false,
            name: "예약 ID",
            value: input.reservationId
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
  try {
    const message = await ky
      .post(buildDiscordWebhookExecuteUrl(input.webhookUrl), {
        json: input.payload,
        retry: { limit: 0 },
        timeout: 10_000
      })
      .json<DiscordWebhookMessage>();
    return { messageIds: message.id ? [message.id] : [] };
  } catch (error) {
    if (error instanceof DiscordWebhookDeliveryError) {
      throw error;
    }
    throw classifyDiscordWebhookError(error, new Date());
  }
}

export function classifyDiscordWebhookError(error: unknown, now: Date): DiscordWebhookDeliveryError {
  if (error instanceof DiscordWebhookDeliveryError) {
    return error;
  }
  if (isTimeoutError(error) || error instanceof TypeError) {
    return new DiscordWebhookDeliveryError({
      code: isTimeoutError(error) ? "discord_timeout" : "discord_network_error",
      message: error instanceof Error ? error.message : "Discord delivery result is unknown",
      outcome: "UNKNOWN"
    });
  }
  if (error instanceof HTTPError) {
    return new DiscordWebhookDeliveryError({
      code: `discord_http_${error.response.status}`,
      message: error.message,
      outcome: "FAILED",
      retryAt: retryAfterAt(error.response.headers, now) ?? new Date(now.getTime() + 60_000)
    });
  }
  return new DiscordWebhookDeliveryError({
    code: "discord_send_failed",
    message: error instanceof Error ? error.message : "Unknown Discord notification error",
    outcome: "FAILED",
    retryAt: new Date(now.getTime() + 60_000)
  });
}

function retryAfterAt(headers: Headers, now: Date): Date | null {
  const retryAfter = headers.get("retry-after") ?? headers.get("x-ratelimit-reset-after");
  if (!retryAfter) {
    return null;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1_000);
  }
  const timestamp = Date.parse(retryAfter);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

export function redactDiscordWebhookTokens(message: string): string {
  return message.replace(DISCORD_WEBHOOK_URL_PATTERN, "$1/[redacted]");
}

function buildApplicantFields(
  applicants: readonly ClosedPeriodNotificationApplicant[]
): readonly DiscordEmbedField[] {
  if (applicants.length === 0) {
    return [{ inline: false, name: "신청자", value: "신청자 없음" }];
  }

  return chunkApplicantLines(applicants.map(formatApplicantLine)).map((chunk, index) => ({
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
