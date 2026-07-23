import { NextResponse } from "next/server";

import { jsonError, type ApiErrorCode } from "@/lib/http";

export type AdminCreateReservationErrorReason =
  | "admin_target"
  | "advance_unavailable"
  | "cancelled_same_slot"
  | "closed"
  | "disabled"
  | "duplicate"
  | "full"
  | "not_found"
  | "not_open_yet"
  | "restricted"
  | "shadow_banned";

export type AdminCreatedReservation = {
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: string;
  readonly studyPeriod: string;
  readonly userId: string;
};

export type AdminCreateReservationResult =
  | { readonly kind: "confirmed"; readonly reservation: AdminCreatedReservation }
  | { readonly kind: "error"; readonly reason: AdminCreateReservationErrorReason };

export function adminCreateError(reason: AdminCreateReservationErrorReason): AdminCreateReservationResult {
  return { kind: "error", reason };
}

export function buildAdminCreateReservationResponse(result: AdminCreateReservationResult): NextResponse {
  if (result.kind === "confirmed") {
    return NextResponse.json({ reservation: result.reservation }, { status: 201 });
  }
  return jsonError(
    statusForAdminCreateReservationError(result.reason),
    codeForAdminCreateReservationError(result.reason),
    messageForAdminCreateReservationError(result.reason)
  );
}

function codeForAdminCreateReservationError(reason: AdminCreateReservationErrorReason): ApiErrorCode {
  switch (reason) {
    case "cancelled_same_slot":
      return "duplicate";
    case "shadow_banned":
      return "restricted";
    case "admin_target":
    case "advance_unavailable":
    case "closed":
    case "disabled":
    case "duplicate":
    case "full":
    case "not_found":
    case "not_open_yet":
    case "restricted":
      return reason;
  }
}

function statusForAdminCreateReservationError(reason: AdminCreateReservationErrorReason): number {
  switch (reason) {
    case "admin_target":
    case "restricted":
    case "shadow_banned":
      return 403;
    case "not_found":
      return 404;
    case "advance_unavailable":
    case "cancelled_same_slot":
    case "closed":
    case "disabled":
    case "duplicate":
    case "full":
    case "not_open_yet":
      return 409;
  }
}

export function messageForAdminCreateReservationError(reason: AdminCreateReservationErrorReason): string {
  switch (reason) {
    case "admin_target":
      return "관리자 계정은 예약자로 추가할 수 없습니다.";
    case "advance_unavailable":
      return "선택한 날짜는 예약할 수 없습니다.";
    case "cancelled_same_slot":
      return "이미 처리된 동일 시간대 예약 기록이 있어 다시 추가할 수 없습니다.";
    case "closed":
      return "예약 시간이 마감되었습니다.";
    case "disabled":
      return "예약이 비활성화된 시간대입니다.";
    case "duplicate":
      return "이미 예약된 시간대입니다.";
    case "full":
      return "정원이 마감되었습니다.";
    case "not_found":
      return "등록된 학생을 찾을 수 없습니다.";
    case "not_open_yet":
      return "아직 예약이 열리지 않았습니다.";
    case "restricted":
      return "예약 이용이 제한된 학생입니다.";
    case "shadow_banned":
      return "블랙리스트 학생은 수동 추가 전에 해제해야 합니다.";
  }
}
