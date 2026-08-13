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

export type AdminAuditActionPage<T extends AdminAuditActionRow> = {
  readonly currentTotal: number;
  readonly next: { readonly createdAt: string; readonly id: string } | null;
  readonly rows: readonly T[];
};

const ADMIN_AUDIT_ACTION_CATEGORIES: Readonly<Record<string, AdminAuditActionCategory>> = {
  ADMIN_RESERVATION_CREATE: "RESERVATION",
  ADMIN_RESERVATION_CANCEL: "RESERVATION",
  DISCORD_RESERVATION_ACCEPT: "RESERVATION",
  CLOSED_LIST_NOTIFICATION_SEND: "NOTIFICATION",
  NO_SHOW_BAN: "NO_SHOW",
  NOTIFICATION_SETTINGS_PATCH: "NOTIFICATION",
  PERIOD_SETTINGS_PATCH: "SETTINGS",
  SHADOW_BAN_CHAOS_CANCEL: "RESERVATION",
  STUDENT_RESERVATION_CANCEL_RESTRICTION: "RESERVATION",
  USER_RESTRICTION_APPLY: "RESTRICTION",
  USER_RESTRICTION_REMOVE: "RESTRICTION",
  USER_SESSIONS_REVOKE: "SESSION"
};

const ADMIN_AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  ADMIN_RESERVATION_CREATE: "관리자 예약 추가",
  ADMIN_RESERVATION_CANCEL: "관리자 예약 취소",
  DISCORD_RESERVATION_ACCEPT: "디스코드 예약 수락",
  CLOSED_LIST_NOTIFICATION_SEND: "마감 명단 전송",
  NO_SHOW_BAN: "노쇼 차단",
  NOTIFICATION_SETTINGS_PATCH: "알림 설정 변경",
  PERIOD_SETTINGS_PATCH: "운영 설정 변경",
  SHADOW_BAN_CHAOS_CANCEL: "블랙리스트 자동 취소",
  STUDENT_RESERVATION_CANCEL_RESTRICTION: "학생 예약 취소 제한",
  USER_RESTRICTION_APPLY: "학생 제재 적용",
  USER_RESTRICTION_REMOVE: "학생 제재 해제",
  USER_SESSIONS_REVOKE: "학생 세션 종료"
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

export function getAdminAuditActionLabel(action: string): string {
  return ADMIN_AUDIT_ACTION_LABELS[action] ?? action;
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
  return [...actions].sort((left, right) =>
    right.createdAt.getTime() - left.createdAt.getTime() || compareText(right.id, left.id)
  );
}

export function normalizeAdminAuditActionFilters(filters: AdminAuditActionFilters): AdminAuditActionFilters {
  return { action: filters.action, query: filters.query.trim().toLocaleLowerCase("ko-KR") };
}

export function paginateAdminAuditActions<T extends AdminAuditActionRow>(input: {
  readonly after: { readonly createdAt: string; readonly id: string } | null;
  readonly cutoff: Date;
  readonly rows: readonly T[];
}): AdminAuditActionPage<T> {
  const eligible = orderAdminAuditActions(input.rows.filter((row) => row.createdAt.getTime() <= input.cutoff.getTime()));
  const after = input.after;
  const remaining = after === null ? eligible : eligible.filter((row) =>
    row.createdAt.getTime() < Date.parse(after.createdAt) ||
    (row.createdAt.getTime() === Date.parse(after.createdAt) && compareText(row.id, after.id) < 0)
  );
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
