import type { AdminUserDetail } from "./admin-types";

type AdminUserSanction = AdminUserDetail["sanctions"][number];

export function actionLabel(action: string): string {
  switch (action) {
    case "ADMIN_RESERVATION_CANCEL":
      return "관리자 취소";
    case "NO_SHOW_BAN":
      return "노쇼 차단";
    case "STUDENT_RESERVATION_CANCEL_RESTRICTION":
      return "예약 취소 제한";
    case "USER_RESTRICTION_APPLY":
      return "학생 제재 적용";
    case "USER_RESTRICTION_REMOVE":
      return "제한 해제";
    case "USER_SESSIONS_REVOKE":
      return "세션 종료";
    default:
      return action;
  }
}

export function formatKst(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}

export function periodLabel(studyPeriod: string): string {
  switch (studyPeriod) {
    case "EIGHTH":
      return "8면학";
    case "FIRST":
      return "1면학";
    default:
      return studyPeriod;
  }
}

export function reservationReasonLabel(reason: string | null): string {
  const normalized = reason?.trim();
  return normalized ? normalized : "사유 미기록";
}

export function sanctionStatusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "적용 중";
    case "REVOKED":
      return "해제";
    default:
      return status;
  }
}

export function sanctionStatusTimestamp(sanction: AdminUserSanction): string {
  if (sanction.status === "REVOKED" && sanction.revokedAt) {
    return sanction.revokedAt;
  }
  return sanction.createdAt;
}

export function sanctionTypeLabel(type: string): string {
  switch (type) {
    case "ADMIN_BAN":
      return "관리자 영구 차단";
    case "ADMIN_RESTRICTION":
      return "관리자 기간 제한";
    case "CANCELLATION_RESTRICTION":
      return "예약 취소 제한";
    case "NO_SHOW_BAN":
      return "노쇼 영구 차단";
    default:
      return type;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "정상";
    case "BANNED":
      return "차단";
    case "SHADOW_BANNED":
      return "블랙리스트(숨김)";
    case "CANCELLED":
      return "취소";
    case "CONFIRMED":
      return "확정";
    case "NO_SHOW":
      return "노쇼";
    case "RESTRICTED":
      return "제한";
    default:
      return status;
  }
}
