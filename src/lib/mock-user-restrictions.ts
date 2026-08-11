import { assertRestrictableUser } from "./admin-users";
import { toKstDate } from "./date";
import { selectCancellableConfirmedReservationIds } from "./admin-cancellable-reservations";
import { getMockAdminPeriodSettings } from "./mock-period-settings";
import { mockReservationUsersById, mockReservations, type MockUser } from "./mock-reservation-state";
import { DEFAULT_SHADOW_BAN_PROFILE, parseShadowBanProfile, type ShadowBanProfile } from "./shadow-ban-profile";

type MockRestrictionStatus = "BANNED" | "RESTRICTED" | "SHADOW_BANNED";

export type MockUserRestrictionResult =
  | { readonly kind: "forbidden"; readonly reason: "admin_target" | "self_restriction" }
  | { readonly kind: "not_found" }
  | {
      readonly cancelledFutureReservationCount: number;
      readonly idempotent?: true;
      readonly kind: "ok";
      readonly user: MockUser;
    };

export function applyMockUserRestriction(input: {
  readonly actorId: string;
  readonly bookingStatus: MockRestrictionStatus;
  readonly now?: Date;
  readonly shadowBanProfile?: ShadowBanProfile;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string;
  readonly targetUserId: string;
}): MockUserRestrictionResult {
  const target = mockReservationUsersById.get(input.targetUserId);
  const guard = restrictableMockUser(input.actorId, target);
  if (guard.kind !== "ok") {
    return guard;
  }
  if (
    guard.user.bookingStatus === "BANNED" &&
    input.bookingStatus === "BANNED" &&
    guard.user.restrictionReason === input.restrictionReason
  ) {
    return { cancelledFutureReservationCount: 0, idempotent: true, kind: "ok", user: guard.user };
  }
  const user = {
    ...guard.user,
    bookingStatus: input.bookingStatus,
    restrictedUntil: input.restrictedUntil,
    restrictionReason: input.restrictionReason,
    shadowBanProfile: input.bookingStatus === "SHADOW_BANNED" ? parseShadowBanProfile(input.shadowBanProfile) : DEFAULT_SHADOW_BAN_PROFILE
  } satisfies MockUser;
  mockReservationUsersById.set(input.targetUserId, user);
  const cancelledFutureReservationCount = shouldCancelFutureReservations(input.bookingStatus)
    ? cancelCurrentAndFutureMockReservations(input.targetUserId, input.now ?? new Date())
    : 0;
  return { cancelledFutureReservationCount, kind: "ok", user };
}

export function removeMockUserRestriction(input: {
  readonly actorId: string;
  readonly targetUserId: string;
}): MockUserRestrictionResult {
  const target = mockReservationUsersById.get(input.targetUserId);
  const guard = restrictableMockUser(input.actorId, target);
  if (guard.kind !== "ok") {
    return guard;
  }
  const user = {
    ...guard.user,
    bookingStatus: "ACTIVE",
    restrictedUntil: null,
    restrictionReason: null,
    shadowBanProfile: DEFAULT_SHADOW_BAN_PROFILE
  } satisfies MockUser;
  mockReservationUsersById.set(input.targetUserId, user);
  return { cancelledFutureReservationCount: 0, kind: "ok", user };
}

function shouldCancelFutureReservations(status: MockRestrictionStatus): boolean {
  return status === "BANNED";
}

function cancelCurrentAndFutureMockReservations(userId: string, now: Date): number {
  const today = toKstDate(now);
  const settings = getMockAdminPeriodSettings(today, now);
  const cancellableIds = new Set(
    selectCancellableConfirmedReservationIds({
      now,
      reservations: mockReservations.filter((reservation) => reservation.userId === userId),
      settings
    })
  );
  let cancelledCount = 0;
  for (const [index, reservation] of mockReservations.entries()) {
    if (!cancellableIds.has(reservation.id)) {
      continue;
    }
    mockReservations[index] = {
      ...reservation,
      status: "CANCELLED",
      updatedAt: now
    };
    cancelledCount += 1;
  }
  return cancelledCount;
}

function restrictableMockUser(
  actorId: string,
  target: MockUser | undefined
): MockUserRestrictionResult | { readonly kind: "ok"; readonly user: MockUser } {
  if (target === undefined) {
    return { kind: "not_found" };
  }
  const guard = assertRestrictableUser({ actorId, target });
  return guard.kind === "ok" ? { kind: "ok", user: target } : { kind: "forbidden", reason: guard.reason };
}
