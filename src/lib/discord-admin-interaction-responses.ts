import { buildDiscordAdminReasonCustomId } from "./discord-admin-custom-ids";
import type { DiscordAdminReasonDraft } from "./discord-admin-intents";

export type DiscordAdminInteractionResponse =
  | { readonly type: 5 }
  | { readonly data: { readonly flags: 64 }; readonly type: 5 }
  | {
      readonly data: {
        readonly components: readonly [{
          readonly components: readonly [{
            readonly custom_id: "reason";
            readonly label: string;
            readonly max_length: 200;
            readonly min_length: 1;
            readonly required: true;
            readonly style: 2;
            readonly type: 4;
          }];
          readonly type: 1;
        }];
        readonly custom_id: string;
        readonly title: string;
      };
      readonly type: 9;
    };

export function buildDiscordAdminReasonModal(input: {
  readonly intent: DiscordAdminReasonDraft;
  readonly secret: string;
  readonly sourceInteractionId: string;
}): DiscordAdminInteractionResponse {
  return {
    data: {
      components: [{
        components: [{ custom_id: "reason", label: "처리 사유", max_length: 200, min_length: 1, required: true, style: 2, type: 4 }],
        type: 1
      }],
      custom_id: buildDiscordAdminReasonCustomId({ secret: input.secret, sourceInteractionId: input.sourceInteractionId }),
      title: modalTitle(input.intent)
    },
    type: 9
  };
}

export function buildDiscordDeferredPublicResponse(): DiscordAdminInteractionResponse {
  return { type: 5 };
}

export function buildDiscordDeferredPrivateResponse(): DiscordAdminInteractionResponse {
  return { data: { flags: 64 }, type: 5 };
}

function modalTitle(intent: DiscordAdminReasonDraft): string {
  switch (intent.kind) {
    case "reservation_cancel": return "예약 취소 사유";
    case "reservation_bulk_cancel": return "일괄 취소 사유";
    case "student_restrict": return "학생 제한 사유";
    case "student_ban": return "학생 차단 사유";
    case "student_blacklist": return "블랙리스트 사유";
    case "student_release": return "제재 해제 사유";
    case "setting_time":
    case "setting_capacity":
    case "setting_enabled": return "설정 변경 사유";
    case "notification_reservation_created":
    case "notification_closed": return "알림 설정 변경 사유";
    default: return assertNever(intent);
  }
}

function assertNever(value: never): never {
  throw new DiscordAdminModalVariantError(JSON.stringify(value));
}

class DiscordAdminModalVariantError extends Error {
  public override readonly name = "DiscordAdminModalVariantError";
}
