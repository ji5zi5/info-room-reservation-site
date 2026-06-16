import { assertRestrictableUser } from "./admin-users";
import { mockReservationUsersById, type MockUser } from "./mock-reservation-state";

type MockRestrictionStatus = "BANNED" | "RESTRICTED" | "SHADOW_BANNED";

export type MockUserRestrictionResult =
  | { readonly kind: "forbidden"; readonly reason: "admin_target" | "self_restriction" }
  | { readonly kind: "not_found" }
  | { readonly kind: "ok"; readonly user: MockUser };

export function applyMockUserRestriction(input: {
  readonly actorId: string;
  readonly bookingStatus: MockRestrictionStatus;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string;
  readonly targetUserId: string;
}): MockUserRestrictionResult {
  const target = mockReservationUsersById.get(input.targetUserId);
  const guard = restrictableMockUser(input.actorId, target);
  if (guard.kind !== "ok") {
    return guard;
  }
  const user = {
    ...guard.user,
    bookingStatus: input.bookingStatus,
    restrictedUntil: input.restrictedUntil,
    restrictionReason: input.restrictionReason
  } satisfies MockUser;
  mockReservationUsersById.set(input.targetUserId, user);
  return { kind: "ok", user };
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
    restrictionReason: null
  } satisfies MockUser;
  mockReservationUsersById.set(input.targetUserId, user);
  return { kind: "ok", user };
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
