import type { ReservationSidebarUser } from "./reservation-sidebar";

export function consumeAdminRedirectMessage(): string | null {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get("admin");
  if (reason === "required" || reason === "forbidden") {
    window.history.replaceState(null, "", window.location.pathname);
    return reason === "required" ? "로그인이 필요합니다." : "관리자 권한이 필요합니다.";
  }
  return null;
}

export function reservationRestrictionMessage(user: ReservationSidebarUser | null): string | null {
  switch (user?.bookingStatus) {
    case "BANNED":
      return "예약 이용이 제한되었습니다.";
    case "RESTRICTED":
      return isRestrictionCurrentlyActive(user.restrictedUntil) ? "예약 이용이 제한되었습니다." : null;
    case "ACTIVE":
    case undefined:
    default:
      return null;
  }
}

function isRestrictionCurrentlyActive(restrictedUntil: string | null): boolean {
  if (!restrictedUntil) {
    return true;
  }
  return Date.parse(restrictedUntil) > Date.now();
}
