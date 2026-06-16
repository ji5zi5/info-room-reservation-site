import type { SessionUser } from "./session";

export function maskStudentFacingSessionUser(user: SessionUser | null): SessionUser | null {
  if (user === null || user.role !== "STUDENT" || user.bookingStatus !== "SHADOW_BANNED") {
    return user;
  }

  return {
    ...user,
    bookingStatus: "ACTIVE",
    restrictionReason: null,
    restrictedUntil: null
  };
}
