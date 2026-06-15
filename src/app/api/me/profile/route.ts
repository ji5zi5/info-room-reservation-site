import { NextResponse } from "next/server";

import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { getMockStudentProfile } from "@/lib/mock-reservation-data";
import type { BookingStatus, ReservationStatus } from "@/lib/reservation-service";
import { requireUser, UnauthorizedSessionError } from "@/lib/session";
import { buildStudentProfilePayload } from "@/lib/student-profile";
import type { StudentProfilePayload, StudentProfileReservationRow, StudentProfileReservationSummary, StudentProfileSanctionRow, StudentProfileSanctionStatus, StudentProfileSanctionSummary, StudentProfileUserRow } from "@/lib/student-profile";
import type { StudyPeriod } from "@/lib/study-periods";

type DbStudentProfileUser = { readonly bookingStatus: string; readonly generation: number; readonly name: string; readonly restrictedUntil: Date | null; readonly restrictionReason: string | null; readonly role: string; readonly studentNumber: string };
type DbReservationRow = { readonly createdAt: Date; readonly date: string; readonly status: string; readonly studyPeriod: string; readonly updatedAt: Date };
type DbReservationCountRow = { readonly _count: { readonly _all: number }; readonly status: string };
type DbSanctionRow = { readonly createdAt: Date; readonly endsAt: Date | null; readonly reason: string; readonly revokedAt: Date | null; readonly startsAt: Date; readonly status: string; readonly type: string };
type BuildDatabaseStudentProfileInput = { readonly currentReservations: readonly DbReservationRow[]; readonly kstToday: string; readonly now: Date; readonly recentReservations: readonly DbReservationRow[]; readonly recentSanctions: readonly DbSanctionRow[]; readonly reservationSummary: StudentProfileReservationSummary; readonly sanctionSummary: StudentProfileSanctionSummary; readonly user: DbStudentProfileUser };

export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    if (user.role === "ADMIN") {
      return jsonError(403, "forbidden", "Student profiles are not available to administrators.");
    }

    const now = new Date();
    if (isNoDatabaseMockMode()) {
      const profile = getMockStudentProfile(user.id, now);
      if (profile === null) {
        return jsonError(404, "not_found", "Student profile was not found.");
      }
      return NextResponse.json(profile);
    }

    const profile = await getDatabaseStudentProfile(user.id, now);
    if (profile === null) {
      return jsonError(404, "not_found", "Student profile was not found.");
    }
    return NextResponse.json(profile);
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    throw error;
  }
}

async function getDatabaseStudentProfile(userId: string, now: Date): Promise<StudentProfilePayload | null> {
  const kstToday = toKstDate(now);
  const [
    user,
    currentReservations,
    recentReservations,
    reservationCounts,
    recentSanctions,
    activeSanctionCount,
    permanentSanctionCount,
    revokedSanctionCount,
    totalSanctionCount
  ] = await Promise.all([
    prisma.user.findUnique({
      select: {
        bookingStatus: true,
        generation: true,
        name: true,
        restrictedUntil: true,
        restrictionReason: true,
        role: true,
        studentNumber: true
      },
      where: { id: userId }
    }),
    prisma.reservation.findMany({
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: reservationSelect,
      where: { date: { gte: kstToday }, status: "CONFIRMED", userId }
    }),
    prisma.reservation.findMany({
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      select: reservationSelect,
      take: 10,
      where: { userId }
    }),
    prisma.reservation.groupBy({
      by: ["status"],
      where: { userId },
      _count: { _all: true }
    }),
    prisma.userSanction.findMany({
      orderBy: { createdAt: "desc" },
      select: sanctionSelect,
      take: 5,
      where: { userId }
    }),
    prisma.userSanction.count({ where: { status: "ACTIVE", userId } }),
    prisma.userSanction.count({ where: { endsAt: null, status: "ACTIVE", userId } }),
    prisma.userSanction.count({ where: { OR: [{ status: "REVOKED" }, { revokedAt: { not: null } }], userId } }),
    prisma.userSanction.count({ where: { userId } })
  ]);

  if (user === null) {
    return null;
  }

  return buildDatabaseStudentProfile({
    currentReservations,
    kstToday,
    now,
    recentReservations,
    recentSanctions,
    reservationSummary: summarizeReservationCounts(reservationCounts),
    sanctionSummary: {
      activeCount: activeSanctionCount,
      permanentCount: permanentSanctionCount,
      revokedCount: revokedSanctionCount,
      totalCount: totalSanctionCount
    },
    user
  });
}

const reservationSelect = { createdAt: true, date: true, status: true, studyPeriod: true, updatedAt: true } as const;
const sanctionSelect = { createdAt: true, endsAt: true, reason: true, revokedAt: true, startsAt: true, status: true, type: true } as const;

function buildDatabaseStudentProfile(input: BuildDatabaseStudentProfileInput): StudentProfilePayload {
  const user = toStudentProfileUserRow(input.user);
  const recentPayload = buildStudentProfilePayload({
    kstToday: input.kstToday,
    now: input.now,
    reservations: input.recentReservations.map(toStudentProfileReservationRow),
    sanctions: input.recentSanctions.map(toStudentProfileSanctionRow),
    user
  });
  const currentPayload = buildStudentProfilePayload({
    kstToday: input.kstToday,
    now: input.now,
    reservations: input.currentReservations.map(toStudentProfileReservationRow),
    sanctions: [],
    user
  });

  return {
    ...recentPayload,
    currentReservations: currentPayload.currentReservations,
    reservationSummary: input.reservationSummary,
    sanctionSummary: input.sanctionSummary
  };
}

function toStudentProfileUserRow(user: DbStudentProfileUser): StudentProfileUserRow {
  return { bookingStatus: parseBookingStatus(user.bookingStatus), generation: user.generation, name: user.name, restrictedUntil: user.restrictedUntil, restrictionReason: user.restrictionReason, role: user.role, studentNumber: user.studentNumber };
}

function toStudentProfileReservationRow(reservation: DbReservationRow): StudentProfileReservationRow {
  return { createdAt: reservation.createdAt, date: reservation.date, status: parseReservationStatus(reservation.status), studyPeriod: parseStudyPeriod(reservation.studyPeriod), updatedAt: reservation.updatedAt };
}

function toStudentProfileSanctionRow(sanction: DbSanctionRow): StudentProfileSanctionRow {
  return { createdAt: sanction.createdAt, endsAt: sanction.endsAt, reason: sanction.reason, revokedAt: sanction.revokedAt, startsAt: sanction.startsAt, status: parseSanctionStatus(sanction.status), type: sanction.type };
}

function summarizeReservationCounts(rows: readonly DbReservationCountRow[]): StudentProfileReservationSummary {
  return rows.reduce<StudentProfileReservationSummary>(
    (summary, row) => {
      const status = parseReservationStatus(row.status);
      switch (status) {
        case "CANCELLED":
          return { ...summary, cancelledCount: row._count._all };
        case "CONFIRMED":
          return { ...summary, confirmedCount: row._count._all };
        case "NO_SHOW":
          return { ...summary, noShowCount: row._count._all };
      }
    },
    { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 }
  );
}

function parseBookingStatus(value: string): BookingStatus {
  switch (value) {
    case "ACTIVE": case "BANNED": case "RESTRICTED": return value;
    default:
      throw new InvalidStudentProfileFieldError("bookingStatus", value);
  }
}

function parseReservationStatus(value: string): ReservationStatus {
  switch (value) {
    case "CANCELLED": case "CONFIRMED": case "NO_SHOW": return value;
    default:
      throw new InvalidStudentProfileFieldError("reservationStatus", value);
  }
}

function parseSanctionStatus(value: string): StudentProfileSanctionStatus {
  switch (value) {
    case "ACTIVE": case "REVOKED": return value;
    default:
      throw new InvalidStudentProfileFieldError("sanctionStatus", value);
  }
}

function parseStudyPeriod(value: string): StudyPeriod {
  switch (value) {
    case "EIGHTH": case "FIRST": return value;
    default:
      throw new InvalidStudentProfileFieldError("studyPeriod", value);
  }
}

class InvalidStudentProfileFieldError extends Error {
  public constructor(field: string, value: string) {
    super(`Invalid student profile ${field}: ${value}`);
    this.name = "InvalidStudentProfileFieldError";
  }
}
