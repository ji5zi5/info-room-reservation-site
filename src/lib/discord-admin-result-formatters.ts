import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminIntent } from "./discord-admin-intents";
import type { DiscordAdminNotificationResult } from "./discord-admin-notification-service";
import type { DiscordAdminReservationResult } from "./discord-admin-reservation-service";
import {
  discordAdminStaleResult,
  discordAdminSuccessResult,
  type DiscordAdminCommandResult
} from "./discord-admin-command-results";
import type { DiscordAdminSettingResult } from "./discord-admin-settings-service";
import type { DiscordAdminUserMutationResult } from "./discord-admin-user-service";
import { getStudyPeriodLabel } from "./study-periods";

export function formatDiscordAdminReservationResult(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: Extract<DiscordAdminIntent, { readonly kind: `reservation_${string}` }>;
  readonly result: DiscordAdminReservationResult;
}): DiscordAdminCommandResult {
  if (input.result.kind === "noop") return stale(input.result.code);
  const fields = actorFields(input.actor);
  switch (input.intent.kind) {
    case "reservation_create":
      return input.result.kind === "created"
        ? discordAdminSuccessResult({
            description: `${input.intent.studentNumber} ${input.result.studentName} 학생 예약을 추가했습니다.`,
            fields: [
              ...fields,
              { inline: false, name: "대상", value: `${input.intent.studentNumber} ${input.result.studentName}` },
              { inline: true, name: "변경 전", value: "예약 없음" },
              { inline: true, name: "변경 후", value: `${input.intent.date} ${getStudyPeriodLabel(input.intent.studyPeriod)} 확정` },
              reasonField(input.intent.reservationReason),
              resultCountField(1, 0)
            ],
            title: "예약 추가 완료"
          })
        : stale("reservation_state_changed");
    case "reservation_cancel":
      return input.result.kind === "cancelled"
        ? discordAdminSuccessResult({
            description: `${input.intent.studentNumber} 학생 예약을 취소했습니다.`,
            fields: [
              ...fields,
              { inline: false, name: "대상", value: `${input.intent.studentNumber} · ${input.intent.date} ${getStudyPeriodLabel(input.intent.studyPeriod)}` },
              { inline: true, name: "변경 전", value: "확정" },
              { inline: true, name: "변경 후", value: "취소" },
              reasonField(input.intent.reason),
              resultCountField(1, 0)
            ],
            title: "예약 취소 완료"
          })
        : stale("reservation_state_changed");
    case "reservation_bulk_cancel":
      return input.result.kind === "bulk_cancelled"
        ? discordAdminSuccessResult({
            description: `${input.intent.date} ${getStudyPeriodLabel(input.intent.studyPeriod)} 예약을 일괄 처리했습니다.`,
            fields: [
              ...fields,
              { inline: false, name: "대상", value: `${input.intent.date} ${getStudyPeriodLabel(input.intent.studyPeriod)} 전체` },
              { inline: true, name: "변경 전", value: `확정 ${input.result.total}건` },
              { inline: true, name: "변경 후", value: `취소 ${input.result.cancelled}건` },
              reasonField(input.intent.reason),
              { inline: false, name: "결과", value: `성공 ${input.result.cancelled} · 실패 ${input.result.conflicts + input.result.invalid} · 충돌 ${input.result.conflicts} · 제외 ${input.result.invalid}` }
            ],
            title: "일괄 취소 완료"
          })
        : stale("reservation_state_changed");
    default: return assertNever(input.intent);
  }
}

export function formatDiscordAdminUserResult(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: Extract<DiscordAdminIntent, { readonly kind: "student_ban" | "student_blacklist" | "student_release" | "student_restrict" }>;
  readonly result: DiscordAdminUserMutationResult;
}): DiscordAdminCommandResult {
  if (input.result.kind === "noop") return stale(input.result.code);
  return discordAdminSuccessResult({
    description: `${input.result.studentNumber} ${input.result.studentName} 학생 상태를 변경했습니다.`,
    fields: [
      ...actorFields(input.actor),
      reasonField(input.intent.reason),
      { inline: false, name: "대상", value: `${input.result.studentNumber} ${input.result.studentName}` },
      { inline: true, name: "변경 전", value: input.result.beforeStatus },
      { inline: true, name: "변경 후", value: input.result.afterStatus },
      resultCountField(1, 0),
      { inline: true, name: "함께 취소된 예약", value: `${input.result.cancelledFutureReservationCount}건` }
    ],
    title: "학생 제재 처리 완료"
  });
}

export function formatDiscordAdminSettingResult(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: Extract<DiscordAdminIntent, { readonly kind: `setting_${string}` }>;
  readonly result: DiscordAdminSettingResult;
}): DiscordAdminCommandResult {
  return discordAdminSuccessResult({
    description: `${getStudyPeriodLabel(input.intent.studyPeriod)} 설정을 변경했습니다.`,
    fields: [
      ...actorFields(input.actor),
      reasonField(input.intent.reason),
      { inline: true, name: "적용 범위", value: input.result.scope === "ALL" ? "전체 날짜" : input.intent.date ?? "특정 날짜" },
      { inline: false, name: "변경 전", value: settingValue(input.result.before) },
      { inline: false, name: "변경 후", value: settingValue(input.result.after) }
    ],
    title: "운영 설정 변경 완료"
  });
}

export function formatDiscordAdminNotificationResult(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: Extract<DiscordAdminIntent, { readonly kind: "closed_list_send" | "notification_closed" | "notification_reservation_created" }>;
  readonly result: DiscordAdminNotificationResult;
}): DiscordAdminCommandResult {
  if (input.result.kind === "noop") return stale(input.result.code);
  if (input.result.kind === "sent") {
    return discordAdminSuccessResult({ description: `마감 명단 메시지 ${input.result.messageCount}개를 전송했습니다.`, fields: actorFields(input.actor), title: "마감 명단 전송 완료" });
  }
  return discordAdminSuccessResult({
    description: "Discord 알림 설정을 변경했습니다.",
    fields: [
      ...actorFields(input.actor),
      ...(input.intent.kind === "closed_list_send" ? [] : [reasonField(input.intent.reason)]),
      { inline: false, name: "변경 전", value: notificationValue(input.result.before) },
      { inline: false, name: "변경 후", value: notificationValue(input.result.after) },
      resultCountField(1, 0)
    ],
    title: "알림 설정 변경 완료"
  });
}

function actorFields(actor: DiscordAuthorizedAdmin) {
  return [{ inline: false, name: "처리 관리자", value: `${actor.studentNumber} ${actor.name}` }] as const;
}

function reasonField(reason: string) {
  return { inline: false, name: "처리 사유", value: reason } as const;
}

function resultCountField(success: number, failure: number) {
  return { inline: false, name: "처리 결과", value: `성공 ${success} · 실패 ${failure}` } as const;
}

function notificationValue(value: { readonly closedEnabled: boolean; readonly reservationEnabled: boolean }): string {
  return `신청 알림 ${enabledLabel(value.reservationEnabled)} · 마감 명단 ${enabledLabel(value.closedEnabled)}`;
}

function settingValue(setting: { readonly capacity: number; readonly closeTime: string; readonly enabled: boolean; readonly openTime: string }): string {
  return `${setting.openTime}~${setting.closeTime} · 정원 ${setting.capacity}명 · ${enabledLabel(setting.enabled)}`;
}

function enabledLabel(enabled: boolean): string {
  return enabled ? "사용" : "중지";
}

function stale(code: string): DiscordAdminCommandResult {
  return discordAdminStaleResult({ description: userFacingCode(code), title: "처리되지 않음" });
}

function userFacingCode(code: string): string {
  const labels: Readonly<Record<string, string>> = {
    admin_target: "관리자 계정에는 이 작업을 적용할 수 없습니다.",
    advance_unavailable: "해당 날짜에는 예약을 추가할 수 없습니다.",
    cancelled_same_slot: "취소 이력이 있는 동일 시간대에는 다시 예약할 수 없습니다.",
    closed: "이미 마감된 시간대입니다.",
    disabled: "운영하지 않는 시간대입니다.",
    duplicate: "이미 예약된 시간대입니다.",
    full: "남은 자리가 없습니다.",
    invalid_status: "현재 예약 상태에서는 처리할 수 없습니다.",
    not_found: "대상을 찾을 수 없습니다.",
    not_open_yet: "아직 신청 시간이 아닙니다.",
    restricted: "예약이 제한된 학생입니다.",
    shadow_banned: "현재 정책상 예약을 추가할 수 없습니다.",
    student_not_found: "일치하는 학생을 찾을 수 없습니다.",
    wrong_type: "선택한 종류와 현재 제재가 일치하지 않습니다."
  };
  return labels[code] ?? "현재 상태에서는 요청을 처리할 수 없습니다.";
}

function assertNever(value: never): never {
  throw new DiscordAdminResultVariantError(JSON.stringify(value));
}

class DiscordAdminResultVariantError extends Error {
  public override readonly name = "DiscordAdminResultVariantError";
}
