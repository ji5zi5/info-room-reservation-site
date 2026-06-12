export const ADMIN_USER_STATUS_FILTERS = ["ACTIVE", "RESTRICTED", "BANNED", "ALL"] as const;

export type AdminUserStatusFilter = (typeof ADMIN_USER_STATUS_FILTERS)[number];

export type AdminUserListRow = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string | null;
  readonly role: string;
  readonly studentNumber: string;
};

export type AdminUserFilterInput = {
  readonly bookingStatus: AdminUserStatusFilter;
  readonly query: string;
};

export function parseAdminUserStatusFilter(value: string | null): AdminUserStatusFilter {
  switch (value) {
    case "ACTIVE":
    case "BANNED":
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
