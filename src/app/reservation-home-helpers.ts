import type { ReservationSidebarUser } from "./reservation-sidebar";

export function consumeAdminRedirectMessage(): string | null {
  const result = readAdminRedirectMessage(window.location.search);
  if (result.message !== null) {
    const query = result.cleanedSearch ? `?${result.cleanedSearch}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
  }
  return result.message;
}

export function readAdminRedirectMessage(search: string): {
  readonly cleanedSearch: string;
  readonly message: string | null;
} {
  const params = new URLSearchParams(search);
  const reason = params.get("admin");
  if (reason !== "required" && reason !== "forbidden") {
    return { cleanedSearch: params.toString(), message: null };
  }
  params.delete("admin");
  return {
    cleanedSearch: params.toString(),
    message: reason === "required" ? "로그인이 필요합니다." : "관리자 권한이 필요합니다."
  };
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
