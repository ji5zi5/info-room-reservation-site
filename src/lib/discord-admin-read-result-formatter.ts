import { buildDiscordAdminStudentSelectCustomId } from "./discord-admin-custom-ids";
import type { DiscordAdminIntent } from "./discord-admin-intents";
import type { DiscordAdminReadResult } from "./discord-admin-query-service";
import {
  discordAdminStaleResult,
  discordAdminSuccessResult,
  type DiscordAdminCommandResult
} from "./discord-admin-command-results";
import { getStudyPeriodLabel, parseStudyPeriod } from "./study-periods";

export function formatDiscordAdminReadResult(input: {
  readonly intent: DiscordAdminIntent;
  readonly result: DiscordAdminReadResult;
  readonly secret: string;
}): DiscordAdminCommandResult {
  switch (input.result.kind) {
    case "periods":
      return discordAdminSuccessResult({
        description: `${input.result.date} 운영 정보`,
        fields: input.result.periods
          .filter((period) => input.intent.kind !== "roster" || input.intent.studyPeriod === null || input.intent.studyPeriod === period.studyPeriod)
          .map((period) => ({
            inline: false,
            name: `${period.label} · ${windowLabel(period.windowState)}`,
            value: [
              `${period.openTime}~${period.closeTime} · ${period.confirmedCount}/${period.capacity}명 · 잔여 ${period.remaining}석`,
              period.applicants.length === 0
                ? "신청자 없음"
                : period.applicants.map((applicant, index) => `${index + 1}. ${applicant.studentNumber} ${applicant.name}`).join("\n")
            ].join("\n")
          })),
        title: input.intent.kind === "settings_get" ? "시간대 설정" : input.intent.kind === "roster" ? "신청자 명단" : "예약 현황"
      });
    case "students":
      return formatStudents(input.result, input.secret);
    case "notification_settings":
      return discordAdminSuccessResult({
        description: "현재 Discord 알림 설정입니다.",
        fields: [
          { inline: true, name: "신청 알림", value: enabledLabel(input.result.reservationEnabled) },
          { inline: true, name: "마감 명단", value: enabledLabel(input.result.closedEnabled) }
        ],
        title: "알림 설정"
      });
    case "operations":
      return discordAdminSuccessResult({
        description: "Discord와 크론 작업 상태입니다.",
        fields: [
          { inline: true, name: "관리자 명령", value: `${input.result.adminCommandBacklog}건` },
          { inline: true, name: "예약 상호작용", value: `${input.result.interactionBacklog}건` },
          { inline: true, name: "알림 확인 필요", value: `${input.result.unresolvedDeliveries}건` },
          ...input.result.operationalJobs.map((job) => ({
            inline: false,
            name: job.job,
            value: `${job.status} · 최근 성공 ${job.lastSuccessAt?.toISOString() ?? "없음"}`
          }))
        ],
        title: input.intent.kind === "operations_backlog" ? "미처리 작업" : "운영 상태"
      });
    default:
      return assertNever(input.result);
  }
}

function formatStudents(
  result: Extract<DiscordAdminReadResult, { readonly kind: "students" }>,
  secret: string
): DiscordAdminCommandResult {
  if (result.students.length === 0) {
    return discordAdminStaleResult({ description: "일치하는 학생을 찾을 수 없습니다.", title: "처리되지 않음" });
  }
  return discordAdminSuccessResult({
    components: result.students.length === 1 ? undefined : [{
      components: [{
        custom_id: buildDiscordAdminStudentSelectCustomId({ secret }),
        max_values: 1,
        min_values: 1,
        options: result.students.map((student) => ({
          description: student.studentNumber,
          label: student.name,
          value: student.studentNumber
        })),
        placeholder: "학생을 선택하세요",
        type: 3
      }],
      type: 1
    }],
    description: result.students.length === 1 ? "학생 상세 정보입니다." : `${result.students.length}명의 검색 결과입니다.`,
    fields: result.students.map((student) => ({
      inline: false,
      name: `${student.studentNumber} ${student.name}`,
      value: [
        `상태 ${student.bookingStatus}${student.shadowBanProfile === "NORMAL" ? "" : ` · 강도 ${student.shadowBanProfile}`}`,
        student.restrictionReason === null ? "제재 사유 없음" : `사유 ${student.restrictionReason}`,
        student.recentReservations.length === 0
          ? "최근 예약 없음"
          : student.recentReservations.map((reservation) => `${reservation.date} ${getStudyPeriodLabel(parseStudyPeriod(reservation.studyPeriod))} ${reservation.status}`).join("\n")
      ].join("\n")
    })),
    title: "학생 조회"
  });
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

function assertNever(value: never): never {
  throw new DiscordAdminReadResultVariantError(JSON.stringify(value));
}

class DiscordAdminReadResultVariantError extends Error {
  public override readonly name = "DiscordAdminReadResultVariantError";
}
