import type { Prisma } from "@prisma/client";

import { ADMIN_EXPORT_PROBE_ROWS, ADMIN_PAGE_SIZE } from "./admin-pagination";
import { STUDY_PERIODS } from "./study-periods";

export const ADMIN_RESERVATION_STATUS_FILTERS = ["CONFIRMED", "NO_SHOW", "CANCELLED", "ALL"] as const;
export const ADMIN_RESERVATION_PERIOD_FILTERS = ["EIGHTH", "FIRST", "ALL"] as const;

export type AdminReservationStatusFilter = (typeof ADMIN_RESERVATION_STATUS_FILTERS)[number];
export type AdminReservationStudyPeriodFilter = (typeof ADMIN_RESERVATION_PERIOD_FILTERS)[number];

type AdminReservationRow = {
  readonly createdAt: Date;
  readonly id: string;
  readonly status: string;
  readonly studyPeriod: string;
};

export type AdminReservationPage<T extends AdminReservationRow> = {
  readonly currentTotal: number;
  readonly next: {
    readonly createdAt: string;
    readonly id: string;
    readonly studyPeriod: "EIGHTH" | "FIRST";
  } | null;
  readonly rows: readonly T[];
};

type AdminReservationUserFilterRow = AdminReservationRow & {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly studentNumber: string;
  };
};

export type AdminReservationQueryFilters = {
  readonly query: string;
  readonly studyPeriod: AdminReservationStudyPeriodFilter;
  readonly userId: string | null;
};

export type AdminReservationFilters = AdminReservationQueryFilters & {
  readonly date: string;
  readonly status: AdminReservationStatusFilter;
};

export function parseAdminReservationStatus(value: string | null): AdminReservationStatusFilter {
  switch (value) {
    case "ALL":
    case "CANCELLED":
    case "CONFIRMED":
    case "NO_SHOW":
      return value;
    default:
      return "CONFIRMED";
  }
}

export function parseAdminReservationStudyPeriod(value: string | null): AdminReservationStudyPeriodFilter {
  switch (value) {
    case "EIGHTH":
    case "FIRST":
      return value;
    case "ALL":
    default:
      return "ALL";
  }
}

export function filterAdminReservations<T extends AdminReservationRow>(
  reservations: readonly T[],
  status: AdminReservationStatusFilter
): readonly T[] {
  if (status === "ALL") {
    return reservations;
  }
  return reservations.filter((reservation) => reservation.status === status);
}

export function filterAdminReservationsByQuery<T extends AdminReservationUserFilterRow>(
  reservations: readonly T[],
  filters: AdminReservationQueryFilters
): readonly T[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("ko-KR");
  return reservations.filter((reservation) => {
    if (filters.userId !== null && reservation.user.id !== filters.userId) {
      return false;
    }
    if (filters.studyPeriod !== "ALL" && reservation.studyPeriod !== filters.studyPeriod) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return (
      reservation.user.name.toLocaleLowerCase("ko-KR").includes(normalizedQuery) ||
      reservation.user.studentNumber.toLocaleLowerCase("ko-KR").includes(normalizedQuery)
    );
  });
}

export function orderAdminReservations<T extends AdminReservationRow>(reservations: readonly T[]): readonly T[] {
  return [...reservations].sort((left, right) => {
    const periodDelta = studyPeriodRank(left.studyPeriod) - studyPeriodRank(right.studyPeriod);
    if (periodDelta !== 0) {
      return periodDelta;
    }
    return left.createdAt.getTime() - right.createdAt.getTime() || compareText(left.id, right.id);
  });
}

export function normalizeAdminReservationFilters(filters: AdminReservationQueryFilters): AdminReservationQueryFilters {
  return {
    query: filters.query.trim().toLocaleLowerCase("ko-KR"),
    studyPeriod: filters.studyPeriod,
    userId: filters.userId?.trim() || null
  };
}

export function parseAdminReservationFilters(parameters: URLSearchParams, defaultDate: string): AdminReservationFilters {
  const normalized = normalizeAdminReservationFilters({
    query: parameters.get("query") ?? "",
    studyPeriod: parseAdminReservationStudyPeriod(parameters.get("studyPeriod")),
    userId: parameters.get("userId")
  });
  return {
    date: parameters.get("date") ?? defaultDate,
    query: normalized.query,
    status: parseAdminReservationStatus(parameters.get("status")),
    studyPeriod: normalized.studyPeriod,
    userId: normalized.userId
  };
}

export function buildAdminReservationWhere(input: {
  readonly after: { readonly createdAt: string; readonly id: string; readonly studyPeriod: "EIGHTH" | "FIRST" } | null;
  readonly cutoff: Date;
  readonly filters: AdminReservationFilters;
}): Prisma.ReservationWhereInput {
  const query = input.filters.query;
  const after = input.after;
  const tuple = after === null
    ? {}
    : after.studyPeriod === "EIGHTH"
      ? {
          OR: [
            { studyPeriod: "FIRST" },
            { studyPeriod: "EIGHTH", createdAt: { gt: new Date(after.createdAt) } },
            { studyPeriod: "EIGHTH", createdAt: new Date(after.createdAt), id: { gt: after.id } }
          ]
        }
      : {
          OR: [
            { studyPeriod: "FIRST", createdAt: { gt: new Date(after.createdAt) } },
            { studyPeriod: "FIRST", createdAt: new Date(after.createdAt), id: { gt: after.id } }
          ]
        };
  return {
    ...tuple,
    createdAt: { lte: input.cutoff },
    date: input.filters.date,
    ...(input.filters.status === "ALL" ? {} : { status: input.filters.status }),
    ...(input.filters.studyPeriod === "ALL" ? {} : { studyPeriod: input.filters.studyPeriod }),
    ...(input.filters.userId === null ? {} : { userId: input.filters.userId }),
    ...(query.length === 0
      ? {}
      : {
          AND: [{
            user: {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { studentNumber: { contains: query, mode: "insensitive" } }
              ]
            }
          }]
        })
  };
}

export function buildAdminReservationPageQuery(input: {
  readonly after: { readonly createdAt: string; readonly id: string; readonly studyPeriod: "EIGHTH" | "FIRST" } | null;
  readonly cutoff: Date;
  readonly filters: AdminReservationFilters;
}): Pick<Prisma.ReservationFindManyArgs, "orderBy" | "take" | "where"> {
  return buildAdminReservationQuery({ ...input, take: ADMIN_PAGE_SIZE + 1 });
}

export function buildAdminReservationExportQuery(input: {
  readonly cutoff: Date;
  readonly filters: AdminReservationFilters;
}): Pick<Prisma.ReservationFindManyArgs, "orderBy" | "take" | "where"> {
  return buildAdminReservationQuery({ after: null, ...input, take: ADMIN_EXPORT_PROBE_ROWS });
}

function buildAdminReservationQuery(input: {
  readonly after: { readonly createdAt: string; readonly id: string; readonly studyPeriod: "EIGHTH" | "FIRST" } | null;
  readonly cutoff: Date;
  readonly filters: AdminReservationFilters;
  readonly take: number;
}): Pick<Prisma.ReservationFindManyArgs, "orderBy" | "take" | "where"> {
  return {
    orderBy: [{ studyPeriod: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: input.take,
    where: buildAdminReservationWhere(input)
  };
}

export function paginateAdminReservations<T extends AdminReservationRow>(input: {
  readonly after: { readonly createdAt: string; readonly id: string; readonly studyPeriod: "EIGHTH" | "FIRST" } | null;
  readonly cutoff: Date;
  readonly rows: readonly T[];
}): AdminReservationPage<T> {
  const eligible = orderAdminReservations(input.rows.filter((row) => row.createdAt.getTime() <= input.cutoff.getTime()));
  const after = input.after;
  const remaining = after === null ? eligible : eligible.filter((row) => compareReservationToCursor(row, after) > 0);
  const rows = remaining.slice(0, 50);
  const last = rows.at(-1);
  const period = last?.studyPeriod;
  return {
    currentTotal: eligible.length,
    next: remaining.length > rows.length && last !== undefined && (period === "EIGHTH" || period === "FIRST")
      ? { createdAt: last.createdAt.toISOString(), id: last.id, studyPeriod: period }
      : null,
    rows
  };
}

function studyPeriodRank(value: string): number {
  const index = STUDY_PERIODS.findIndex((period) => period === value);
  return index === -1 ? STUDY_PERIODS.length : index;
}

function compareReservationToCursor(
  row: AdminReservationRow,
  cursor: { readonly createdAt: string; readonly id: string; readonly studyPeriod: "EIGHTH" | "FIRST" }
): number {
  return studyPeriodRank(row.studyPeriod) - studyPeriodRank(cursor.studyPeriod) ||
    row.createdAt.getTime() - Date.parse(cursor.createdAt) || compareText(row.id, cursor.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
