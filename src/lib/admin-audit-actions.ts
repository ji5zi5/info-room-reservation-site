export const ADMIN_AUDIT_ACTION_FILTERS = [
  "ALL",
  "RESTRICTION",
  "RESERVATION",
  "SESSION",
  "NO_SHOW",
  "SETTINGS",
  "NOTIFICATION",
  "OTHER"
] as const;

export type AdminAuditActionFilter = (typeof ADMIN_AUDIT_ACTION_FILTERS)[number];
export type AdminAuditActionCategory = Exclude<AdminAuditActionFilter, "ALL">;

type AdminAuditPerson = {
  readonly name: string;
  readonly studentNumber: string;
};

export type AdminAuditActionRow = {
  readonly action: string;
  readonly actor: AdminAuditPerson | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly reason: string | null;
  readonly targetUser: AdminAuditPerson | null;
};

export type AdminAuditActionFilters = {
  readonly action: AdminAuditActionFilter;
  readonly query: string;
};

const ADMIN_AUDIT_ACTION_CATEGORIES: Readonly<Record<string, AdminAuditActionCategory>> = {
  ADMIN_RESERVATION_CANCEL: "RESERVATION",
  CLOSED_LIST_NOTIFICATION_SEND: "NOTIFICATION",
  NO_SHOW_BAN: "NO_SHOW",
  PERIOD_SETTINGS_PATCH: "SETTINGS",
  STUDENT_RESERVATION_CANCEL_RESTRICTION: "RESERVATION",
  USER_RESTRICTION_APPLY: "RESTRICTION",
  USER_RESTRICTION_REMOVE: "RESTRICTION",
  USER_SESSIONS_REVOKE: "SESSION"
};

export function parseAdminAuditActionFilter(value: string | null): AdminAuditActionFilter {
  switch (value) {
    case "NO_SHOW":
    case "NOTIFICATION":
    case "OTHER":
    case "RESERVATION":
    case "RESTRICTION":
    case "SESSION":
    case "SETTINGS":
      return value;
    case "ALL":
    default:
      return "ALL";
  }
}

export function classifyAdminAuditAction(action: string): AdminAuditActionCategory {
  return ADMIN_AUDIT_ACTION_CATEGORIES[action] ?? "OTHER";
}

export function filterAdminAuditActions<T extends AdminAuditActionRow>(
  actions: readonly T[],
  filters: AdminAuditActionFilters
): readonly T[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase("ko-KR");
  return actions.filter(
    (action) =>
      (filters.action === "ALL" || classifyAdminAuditAction(action.action) === filters.action) &&
      (!normalizedQuery ||
        auditSearchTokens(action).some((token) => token.toLocaleLowerCase("ko-KR").includes(normalizedQuery)))
  );
}

export function orderAdminAuditActions<T extends AdminAuditActionRow>(actions: readonly T[]): readonly T[] {
  return [...actions].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

function auditSearchTokens(action: AdminAuditActionRow): readonly string[] {
  return [
    action.action,
    action.reason ?? "",
    action.actor?.name ?? "",
    action.actor?.studentNumber ?? "",
    action.targetUser?.name ?? "",
    action.targetUser?.studentNumber ?? ""
  ];
}
