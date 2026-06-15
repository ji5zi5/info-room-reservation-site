import type { AdminUserListRow } from "./admin-users";
import type { Reservation } from "./reservation-service";
import type { SessionUser } from "./session";

export type MockUser = AdminUserListRow;

type MockReservationState = { readonly reservations: MockReservation[]; readonly usersById: Map<string, MockUser> };

declare global {
  var __infoRoomMockReservationData: MockReservationState | undefined;
}

export type MockReservation = Reservation & {
  readonly createdAt: Date;
  readonly user: Pick<MockUser, "bookingStatus" | "id" | "name" | "role" | "studentNumber">;
};

export type MockCancelResult =
  | { readonly kind: "cancelled"; readonly reservation: MockReservation; readonly user: SessionUser }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" };

const mockState = getGlobalMockReservationState();

export const mockReservationUsersById = mockState.usersById;
export const mockReservations = mockState.reservations;

export function upsertMockReservationUserRecord(user: SessionUser): MockUser {
  const existing = mockReservationUsersById.get(user.id);
  const nextUser = {
    bookingStatus: existing?.bookingStatus ?? user.bookingStatus,
    generation: user.generation,
    id: user.id,
    name: user.name,
    restrictedUntil: existing?.restrictedUntil ?? parseNullableDate(user.restrictedUntil),
    restrictionReason: existing?.restrictionReason ?? null,
    role: user.role,
    studentNumber: user.studentNumber
  } satisfies MockUser;
  mockReservationUsersById.set(user.id, nextUser);
  return nextUser;
}

export function resetMockReservationDataForTests(): void {
  mockReservationUsersById.clear();
  mockReservations.length = 0;
}

function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function getGlobalMockReservationState(): MockReservationState {
  globalThis.__infoRoomMockReservationData ??= {
    reservations: [],
    usersById: new Map<string, MockUser>()
  };
  return globalThis.__infoRoomMockReservationData;
}
