export type DiscordInteractionResponse =
  | { readonly type: 1 }
  | { readonly data: { readonly flags: 64 }; readonly type: 5 }
  | { readonly data: { readonly content: string; readonly flags: 64 }; readonly type: 4 }
  | {
      readonly data: {
        readonly components: readonly [{ readonly components: readonly [{ readonly custom_id: "reason"; readonly label: string; readonly max_length: 200; readonly min_length: 1; readonly required: true; readonly style: 2; readonly type: 4 }]; readonly type: 1 }];
        readonly custom_id: string;
        readonly title: string;
      };
      readonly type: 9;
    };

export function buildDiscordPongResponse(): DiscordInteractionResponse {
  return { type: 1 };
}

export function buildDiscordRejectReasonModal(reservationId: string): DiscordInteractionResponse {
  return {
    data: {
      components: [{
        components: [{ custom_id: "reason", label: "거절 사유", max_length: 200, min_length: 1, required: true, style: 2, type: 4 }],
        type: 1
      }],
      custom_id: `reservation:reject:${reservationId}`,
      title: "예약 거절 사유"
    },
    type: 9
  };
}

export function buildDiscordDeferredEphemeralResponse(): DiscordInteractionResponse {
  return { data: { flags: 64 }, type: 5 };
}

export function buildDiscordImmediateEphemeralErrorResponse(): DiscordInteractionResponse {
  return { data: { content: "요청을 처리할 수 없습니다.", flags: 64 }, type: 4 };
}
