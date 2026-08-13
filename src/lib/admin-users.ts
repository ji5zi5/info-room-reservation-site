import type { Prisma } from "@prisma/client";

import { ADMIN_PAGE_SIZE } from "./admin-pagination";

export const ADMIN_USER_STATUS_FILTERS = ["ACTIVE", "RESTRICTED", "BANNED", "SHADOW_BANNED", "ALL"] as const;

export type AdminUserStatusFilter = (typeof ADMIN_USER_STATUS_FILTERS)[number];

export type AdminUserListRow = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string | null;
  readonly role: string;
  readonly shadowBanProfile: string;
  readonly studentNumber: string;
};

export type AdminUserFilterInput = {
  readonly bookingStatus: AdminUserStatusFilter;
  readonly query: string;
};

export type AdminUserCursorRow = {
  readonly createdAt: Date;
  readonly id: string;
};

export type AdminUserPage<T extends AdminUserCursorRow> = {
  readonly currentTotal: number;
  readonly next: { readonly createdAt: string; readonly id: string } | null;
  readonly rows: readonly T[];
};

export type RestrictableUserResult =
  | {
      readonly kind: "ok";
    }
  | {
      readonly kind: "error";
      readonly reason: "admin_target" | "self_restriction";
    };

export function parseAdminUserStatusFilter(value: string | null): AdminUserStatusFilter {
  switch (value) {
    case "ACTIVE":
    case "BANNED":
    case "SHADOW_BANNED":
    case "RESTRICTED":
      return value;
    case "ALL":
    default:
      return "ALL";
  }
}

export function filterAdminUsers(
  users: readonly AdminUserListRow[],
  filters: AdminUserFilterInput
): readonly AdminUserListRow[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("ko-KR");
  return users.filter((user) => {
    const statusMatches = filters.bookingStatus === "ALL" || user.bookingStatus === filters.bookingStatus;
    if (!statusMatches) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return (
      user.name.toLocaleLowerCase("ko-KR").includes(normalizedQuery) ||
      user.studentNumber.toLocaleLowerCase("ko-KR").includes(normalizedQuery)
    );
  });
}

export function normalizeAdminUserFilters(filters: AdminUserFilterInput): AdminUserFilterInput {
  return { bookingStatus: filters.bookingStatus, query: filters.query.trim().toLocaleLowerCase("ko-KR") };
}

export function buildAdminUserWhere(input: {
  readonly after: { readonly createdAt: string; readonly id: string } | null;
  readonly cutoff: Date;
  readonly filters: AdminUserFilterInput;
}): Prisma.UserWhereInput {
  const query = input.filters.query;
  const tuple = input.after === null
    ? {}
    : {
        OR: [
          { createdAt: { gt: new Date(input.after.createdAt) } },
          { createdAt: new Date(input.after.createdAt), id: { gt: input.after.id } }
        ]
      };
  return {
    ...tuple,
    createdAt: { lte: input.cutoff },
    ...(input.filters.bookingStatus === "ALL" ? {} : { bookingStatus: input.filters.bookingStatus }),
    ...(query.length === 0
      ? {}
      : {
          AND: [{
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { studentNumber: { contains: query, mode: "insensitive" } }
            ]
          }]
        })
  };
}

export function buildAdminUserPageQuery(input: {
  readonly after: { readonly createdAt: string; readonly id: string } | null;
  readonly cutoff: Date;
  readonly filters: AdminUserFilterInput;
}): Pick<Prisma.UserFindManyArgs, "orderBy" | "take" | "where"> {
  return {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: ADMIN_PAGE_SIZE + 1,
    where: buildAdminUserWhere(input)
  };
}

export function orderAdminUsers<T extends AdminUserCursorRow>(users: readonly T[]): readonly T[] {
  return [...users].sort((left, right) =>
    left.createdAt.getTime() - right.createdAt.getTime() || compareText(left.id, right.id)
  );
}

export function paginateAdminUsers<T extends AdminUserCursorRow>(input: {
  readonly after: { readonly createdAt: string; readonly id: string } | null;
  readonly cutoff: Date;
  readonly rows: readonly T[];
}): AdminUserPage<T> {
  const eligible = orderAdminUsers(input.rows.filter((row) => row.createdAt.getTime() <= input.cutoff.getTime()));
  const after = input.after;
  const afterTime = after === null ? null : Date.parse(after.createdAt);
  const remaining = after === null
    ? eligible
    : eligible.filter((row) => row.createdAt.getTime() > (afterTime ?? 0) ||
      (row.createdAt.getTime() === afterTime && compareText(row.id, after.id) > 0));
  const rows = remaining.slice(0, 50);
  const last = rows.at(-1);
  return {
    currentTotal: eligible.length,
    next: remaining.length > rows.length && last !== undefined
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : null,
    rows
  };
}

export function assertRestrictableUser(input: {
  readonly actorId: string;
  readonly target: Pick<AdminUserListRow, "id" | "role">;
}): RestrictableUserResult {
  if (input.actorId === input.target.id) {
    return { kind: "error", reason: "self_restriction" };
  }
  if (input.target.role === "ADMIN") {
    return { kind: "error", reason: "admin_target" };
  }
  return { kind: "ok" };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
