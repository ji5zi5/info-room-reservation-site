import {
  type DiscordActionRowComponent,
  type DiscordBotMessagePayload,
  type DiscordEmbed,
  type DiscordEmbedField,
  buildReservationMessageNonce
} from "./discord-bot";
import { getStudyPeriodLabel, type StudyPeriod } from "./study-periods";

type DiscordReservationMessageInput = {
  readonly applicant: {
    readonly name: string;
    readonly studentNumber: string;
  };
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly reason: string | null;
  readonly reservationId: string;
  readonly studyPeriod: StudyPeriod;
};

const INITIAL_MESSAGE_ACTIONS: readonly DiscordActionRowComponent[] = [
  {
    components: [
      { custom_id: "", label: "수락", style: 3, type: 2 },
      { custom_id: "", label: "거절", style: 4, type: 2 }
    ],
    type: 1
  }
];

export function buildDiscordReservationInitialMessage(
  input: DiscordReservationMessageInput
): DiscordBotMessagePayload {
  return {
    allowed_mentions: { parse: [] },
    components: reservationActions(input.reservationId),
    embeds: [reservationEmbed(input, "정보실 예약 신청")]
  };
}

export function buildDiscordReservationAcceptedMessage(
  input: DiscordReservationMessageInput
): DiscordBotMessagePayload {
  return terminalReservationMessage(input, "예약 신청 수락 처리");
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

function reservationActions(reservationId: string): readonly DiscordActionRowComponent[] {
  const [row] = INITIAL_MESSAGE_ACTIONS;
  if (row === undefined) {
    return [];
  }
  return [
    {
      ...row,
      components: row.components.map((button) => ({
        ...button,
        custom_id: `reservation:${button.label === "수락" ? "accept" : "reject"}:${reservationId}`
      }))
    }
  ];
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
      }
    ],
    title
  };
}

function closeTimestamp(date: string, closeTime: string): number {
  return Math.floor(new Date(`${date}T${closeTime}:00+09:00`).getTime() / 1_000);
}
