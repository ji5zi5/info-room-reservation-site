import type {
  EffectiveBookingStatus,
  StudentProfileSanctionSummary,
  StudentProfileStatusMessage,
  StudentProfileUserPayload,
  StudentProfileUserRow
} from "./student-profile";

export const EMPTY_STUDENT_PROFILE_SANCTION_SUMMARY: StudentProfileSanctionSummary = {
  activeCount: 0,
  permanentCount: 0,
  revokedCount: 0,
  totalCount: 0
};

export function shouldExposeStudentProfileSanctions(user: Pick<StudentProfileUserRow, "bookingStatus">): boolean {
  return user.bookingStatus !== "SHADOW_BANNED";
}

export function toStudentFacingProfileUser(user: StudentProfileUserRow): StudentProfileUserPayload {
  if (user.bookingStatus === "SHADOW_BANNED") {
    return {
      bookingStatus: "ACTIVE",
      generation: user.generation,
      name: user.name,
      restrictionReason: null,
      restrictedUntil: null,
      role: user.role,
      studentNumber: user.studentNumber
    };
  }

  return {
    bookingStatus: user.bookingStatus,
    generation: user.generation,
    name: user.name,
    restrictionReason: user.restrictionReason,
    restrictedUntil: toIsoString(user.restrictedUntil),
    role: user.role,
    studentNumber: user.studentNumber
  };
}

export function getEffectiveBookingStatus(user: StudentProfileUserRow, now: Date): EffectiveBookingStatus {
  switch (user.bookingStatus) {
    case "ACTIVE":
    case "SHADOW_BANNED":
      return "ACTIVE";
    case "BANNED":
      return "BANNED";
    case "RESTRICTED":
      return user.restrictedUntil === null || user.restrictedUntil.getTime() > now.getTime() ? "RESTRICTED" : "ACTIVE";
    default:
      return assertNever(user.bookingStatus);
  }
}

export function getStudentProfileStatusMessage(status: EffectiveBookingStatus): StudentProfileStatusMessage {
  switch (status) {
    case "ACTIVE":
    case "SHADOW_BANNED":
      return "예약 가능";
    case "BANNED":
      return "영구 제한";
    case "RESTRICTED":
      return "예약 제한";
    default:
      return assertNever(status);
  }
}

function toIsoString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function assertNever(value: never): never {
  throw new UnreachableStudentProfileVisibilityVariantError(String(value));
}

class UnreachableStudentProfileVisibilityVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled student profile visibility variant: ${value}`);
    this.name = "UnreachableStudentProfileVisibilityVariantError";
  }
}
