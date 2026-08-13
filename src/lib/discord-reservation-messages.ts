import {
  type DiscordActionRowComponent,
  type DiscordBotMessagePayload,
  type DiscordEmbed,
  type DiscordEmbedField,
  buildReservationMessageNonce
} from "./discord-bot";
import { getStudyPeriodLabel, type StudyPeriod } from "./study-periods";
import { buildDiscordReservationCustomId, type DiscordReservationCustomIdAction } from "./discord-interaction-contracts";

type DiscordReservationMessageInput = {
  readonly applicant: {
    readonly name: string;
    readonly studentNumber: string;
  };
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly customIdSecret?: string;
  readonly reason: string | null;
  readonly renderedEpoch?: number;
  readonly reservationId: string;
  readonly sourceIdentity?: string;
  readonly studyPeriod: StudyPeriod;
  readonly action?: {
    readonly actor: string;
    readonly at: Date;
    readonly label?: string;
    readonly reason: string | null;
  };
};

export function buildDiscordReservationInitialMessage(
  input: DiscordReservationMessageInput
): DiscordBotMessagePayload {
  return {
    allowed_mentions: { parse: [] },
    components: reservationActions(input),
    embeds: [reservationEmbed(input, "정보실 예약 신청")]
  };
}

export function buildDiscordReservationAcceptedMessage(
  input: DiscordReservationMessageInput
): DiscordBotMessagePayload {
  return {
    allowed_mentions: { parse: [] },
    components: reservationActions(input, [
      { action: "admin_cancel", label: "관리자 취소", style: 4 },
      { action: "no_show", label: "노쇼", style: 2 }
    ]),
    embeds: [reservationEmbed(input, "예약 신청 수락 처리")]
  };
}

export function buildDiscordReservationCancelledMessage(
  input: DiscordReservationMessageInput & { readonly cancellationReason: string }
): DiscordBotMessagePayload {
  return terminalReservationMessage(input, "예약 신청 취소 처리", {
    inline: false,
    name: "취소 사유",
    value: input.cancellationReason
  });
}

export function buildDiscordReservationStaleMessage(
  input: DiscordReservationMessageInput
): DiscordBotMessagePayload {
  return terminalReservationMessage(input, "예약 신청 처리 불가");
}

export { buildReservationMessageNonce };

function terminalReservationMessage(
  input: DiscordReservationMessageInput,
  title: string,
  extraField?: DiscordEmbedField
): DiscordBotMessagePayload {
  const embed = reservationEmbed(input, title);
  return {
    allowed_mentions: { parse: [] },
    components: [],
    embeds: [
      {
        ...embed,
        fields: extraField === undefined ? embed.fields : [...embed.fields, extraField]
      }
    ]
  };
}

function reservationActions(
  input: DiscordReservationMessageInput,
  actions: readonly { readonly action: DiscordReservationCustomIdAction; readonly label: string; readonly style: 1 | 2 | 3 | 4 | 5 }[] = [
    { action: "accept", label: "수락", style: 3 },
    { action: "reject", label: "거절", style: 4 }
  ]
): readonly DiscordActionRowComponent[] {
  const secret = input.customIdSecret ?? process.env.DISCORD_BOT_TOKEN;
  if (secret === undefined || secret.length === 0) return [];
  const renderedEpoch = input.renderedEpoch ?? 0;
  return [
    {
      components: actions.map(({ action, label, style }) => ({
        custom_id: buildDiscordReservationCustomId({
          action,
          renderedEpoch,
          reservationId: input.reservationId,
          secret,
          sourceIdentity: input.sourceIdentity ?? buildReservationMessageNonce(input.reservationId)
        }),
        label,
        style,
        type: 2
      })),
      type: 1
    }
  ];
}

export function buildDiscordReservationNoShowMessage(
  input: DiscordReservationMessageInput
): DiscordBotMessagePayload {
  return terminalReservationMessage(input, "예약 노쇼 처리");
}

function reservationEmbed(input: DiscordReservationMessageInput, title: string): DiscordEmbed {
  return {
    color: 0x1f6feb,
    description: `${input.date} · ${getStudyPeriodLabel(input.studyPeriod)}`,
    fields: [
      { inline: true, name: "신청자", value: `${input.applicant.studentNumber} ${input.applicant.name}` },
      { inline: false, name: "신청 사유", value: input.reason ?? "사유 미기록" },
      { inline: true, name: "현재 신청", value: `${input.confirmedCount}/${input.capacity}명` },
      { inline: true, name: "남은 자리", value: `${Math.max(input.capacity - input.confirmedCount, 0)}석` },
      {
        inline: false,
        name: "예약 마감",
        value: `${input.date} ${input.closeTime} KST (<t:${closeTimestamp(input.date, input.closeTime)}:R>)`
      },
      ...actionFields(input.action)
    ],
    title
  };
}

function actionFields(action: DiscordReservationMessageInput["action"]): readonly DiscordEmbedField[] {
  if (action === undefined) return [];
  return [
    ...(action.label === undefined ? [] : [{ inline: false, name: "처리 작업", value: action.label }]),
    { inline: false, name: "처리 관리자", value: action.actor },
    { inline: false, name: "처리 시각", value: action.at.toISOString() },
    { inline: false, name: "처리 사유", value: action.reason ?? "사유 미기록" }
  ];
}

function closeTimestamp(date: string, closeTime: string): number {
  return Math.floor(new Date(`${date}T${closeTime}:00+09:00`).getTime() / 1_000);
}
