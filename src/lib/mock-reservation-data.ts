import { filterAdminReservations, filterAdminReservationsByQuery, orderAdminReservations } from "./admin-reservations";
import type { AdminReservationQueryFilters, AdminReservationStatusFilter } from "./admin-reservations";
import { summarizeAdminUserReservations } from "./admin-user-detail";
import { filterAdminUsers, type AdminUserFilterInput, type AdminUserListRow } from "./admin-users";
import { toKstDate } from "./date";
import type { PeriodSummary } from "./period-settings";
import { getMockAdminPeriodSettings } from "./mock-period-settings";
import { buildStudentCancellationRestriction, type Reservation, type ReservationResult } from "./reservation-service";
import type { SessionUser } from "./session";
import type { StudyPeriod } from "./study-periods";

type MockUser = AdminUserListRow;

type MockReservation = Reservation & {
  readonly createdAt: Date;
  readonly user: {
    readonly bookingStatus: string;
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly studentNumber: string;
  };
};

type MockCancelResult =
  | {
      readonly kind: "cancelled";
      readonly reservation: MockReservation;
      readonly user: SessionUser;
    }
  | {
      readonly kind: "forbidden";
    }
  | {
      readonly kind: "not_found";
    };

const mockState = getGlobalMockReservationState();
const usersById = mockState.usersById;
const reservations = mockState.reservations;

export function upsertMockReservationUser(user: SessionUser): void {
  const existing = usersById.get(user.id);
  usersById.set(user.id, {
    bookingStatus: existing?.bookingStatus ?? user.bookingStatus,
    generation: user.generation,
    id: user.id,
    name: user.name,
    restrictedUntil: existing?.restrictedUntil ?? parseNullableDate(user.restrictedUntil),
    restrictionReason: existing?.restrictionReason ?? null,
    role: user.role,
    studentNumber: user.studentNumber
  });
}

export function getMockAdminUsers(filters: AdminUserFilterInput): readonly MockUser[] {
  return filterAdminUsers([...usersById.values()], filters).slice(0, 100);
}

export function getMockAdminReservations(input: {
  readonly filters: AdminReservationQueryFilters;
  readonly status: AdminReservationStatusFilter;
  readonly date: string;
}): readonly MockReservation[] {
  const dateReservations = reservations.filter((reservation) => reservation.date === input.date);
  return orderAdminReservations(filterAdminReservationsByQuery(filterAdminReservations(dateReservations, input.status), input.filters));
}

export function getMockAdminUserDetail(userId: string): object | null {
  const user = usersById.get(userId);
  if (!user) {
    return null;
  }
  const now = new Date();
  const userReservations = reservations
    .filter((reservation) => reservation.userId === userId)
    .map((reservation) => ({
      createdAt: reservation.createdAt,
      date: reservation.date,
      id: reservation.id,
      status: reservation.status,
      studyPeriod: reservation.studyPeriod,
      updatedAt: reservation.createdAt,
      userId: reservation.userId
    }));
  const today = toKstDate(now);
  return {
    adminActions: [],
    auditLogs: [],
    currentReservations: userReservations.filter(
      (reservation) => reservation.status === "CONFIRMED" && reservation.date >= today
    ),
    reservationHistory: userReservations,
    sanctions: [],
    sanctionSummary: {
      activeCount: 0,
      permanentCount: 0,
      revokedCount: 0,
      totalCount: 0
    },
    sessionSummary: {
      activeCount: 1,
      expiredCount: 0,
      totalCount: 1
    },
    summary: summarizeAdminUserReservations(userReservations),
    user: {
      ...user,
      createdAt: now,
      updatedAt: now
    }
  };
}

export function getMockPeriodSummariesForUser(input: {
  readonly currentUserId: string;
  readonly date: string;
  readonly now?: Date;
}): readonly PeriodSummary[] {
  const summaries = getMockAdminPeriodSettings(input.date, input.now);
  return summaries.map((summary) => {
    const confirmedReservations = reservations.filter(
      (reservation) =>
        reservation.date === input.date && reservation.studyPeriod === summary.studyPeriod && reservation.status === "CONFIRMED"
    );
    const applicants = confirmedReservations.map((reservation) => ({
      name: reservation.user.name,
      reservationId: reservation.id,
      studentNumber: reservation.user.studentNumber
    }));
    return {
      ...summary,
      applicants,
      confirmedCount: confirmedReservations.length,
      myReservationId:
        confirmedReservations.find((reservation) => reservation.user.id === input.currentUserId)?.id ?? null,
      remaining: Math.max(summary.capacity - confirmedReservations.length, 0)
    };
  });
}

export function reserveMockStudyPeriod(input: {
  readonly date: string;
  readonly now: Date;
  readonly studyPeriod: StudyPeriod;
  readonly user: SessionUser;
}): ReservationResult {
  upsertMockReservationUser(input.user);
  const user = usersById.get(input.user.id);
  if (!user) {
    return { kind: "error", reason: "not_found" };
  }
  if (isMockUserRestricted(user, input.now)) {
    return { kind: "error", reason: "restricted" };
  }

  const summary = getMockPeriodSummariesForUser({
    currentUserId: input.user.id,
    date: input.date,
    now: input.now
  }).find((period) => period.studyPeriod === input.studyPeriod);
  if (!summary) {
    return { kind: "error", reason: "not_found" };
  }
  if (!summary.enabled) {
    return { kind: "error", reason: "disabled" };
  }
  if (summary.windowState !== "open") {
    return { kind: "error", reason: summary.windowState };
  }
  if (summary.myReservationId) {
    return { kind: "error", reason: "duplicate" };
  }
  if (summary.confirmedCount >= summary.capacity) {
    return { kind: "error", reason: "full" };
  }

  const reservation = createMockReservation(input, user);
  reservations.push(reservation);
  return { kind: "confirmed", reservation };
}

export function cancelMockReservation(input: {
  readonly id: string;
  readonly now: Date;
  readonly user: SessionUser;
}): MockCancelResult {
  upsertMockReservationUser(input.user);
  const index = reservations.findIndex((reservation) => reservation.id === input.id);
  if (index === -1) {
    return { kind: "not_found" };
  }
  const reservation = reservations[index];
  if (!reservation) {
    return { kind: "not_found" };
  }
  if (reservation.user.id !== input.user.id && input.user.role !== "ADMIN") {
    return { kind: "forbidden" };
  }
  if (reservation.status !== "CANCELLED") {
    const cancelledReservation = {
      ...reservation,
      status: "CANCELLED"
    } satisfies MockReservation;
    reservations[index] = cancelledReservation;
  }

  const user = usersById.get(input.user.id);
  if (!user) {
    return { kind: "not_found" };
  }
  if (reservation.user.id === input.user.id && input.user.role !== "ADMIN") {
    const restriction = buildStudentCancellationRestriction(input.now);
    usersById.set(input.user.id, {
      ...user,
      bookingStatus: restriction.bookingStatus,
      restrictedUntil: restriction.restrictedUntil,
      restrictionReason: restriction.restrictionReason
    });
  }

  const nextUser = usersById.get(input.user.id);
  if (!nextUser) {
    return { kind: "not_found" };
  }
  const nextReservation = reservations[index];
  if (!nextReservation) {
    return { kind: "not_found" };
  }
  return {
    kind: "cancelled",
    reservation: nextReservation,
    user: {
      ...input.user,
      bookingStatus: nextUser.bookingStatus,
      restrictedUntil: nextUser.restrictedUntil ? nextUser.restrictedUntil.toISOString() : null
    }
  };
}

export function resetMockReservationDataForTests(): void {
  usersById.clear();
  reservations.length = 0;
}

function createMockReservation(
  input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
    readonly user: SessionUser;
  },
  user: MockUser
): MockReservation {
  return {
    createdAt: new Date(),
    date: input.date,
    id: `mock-reservation-${reservations.length + 1}`,
    status: "CONFIRMED",
    studyPeriod: input.studyPeriod,
    user: {
      bookingStatus: user.bookingStatus,
      id: user.id,
      name: user.name,
      role: user.role,
      studentNumber: user.studentNumber
    },
    userId: input.user.id
  };
}

function isMockUserRestricted(user: MockUser, now: Date): boolean {
  if (user.bookingStatus === "BANNED") {
    return true;
  }
  if (user.bookingStatus === "RESTRICTED") {
    return user.restrictedUntil === null || user.restrictedUntil.getTime() > now.getTime();
  }
  return false;
}

function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function getGlobalMockReservationState(): {
  readonly reservations: MockReservation[];
  readonly usersById: Map<string, MockUser>;
} {
  const globalStore = globalThis as typeof globalThis & {
    __infoRoomMockReservationData?: {
      readonly reservations: MockReservation[];
      readonly usersById: Map<string, MockUser>;
    };
  };
  globalStore.__infoRoomMockReservationData ??= {
    reservations: [],
    usersById: new Map<string, MockUser>()
  };
  return globalStore.__infoRoomMockReservationData;
}
