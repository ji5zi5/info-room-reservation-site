import {
  AdminAuditActionsPayloadSchema,
  AdminDashboardPayloadSchema,
  AdminReservationsPayloadSchema,
  AdminSettingsPayloadSchema,
  AdminStatisticsPayloadSchema,
  AdminUserDetailSchema,
  AdminUsersPayloadSchema,
  type AdminAuditAction,
  type AdminAuditActionFilter,
  type AdminDashboardPeriod,
  type AdminPeriodSetting,
  type AdminReservation,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter,
  type AdminStatistics,
  type AdminUser,
  type AdminUserDetail,
  type AdminUserStatusFilter,
  type StudyPeriod
} from "./admin-types";
import { csrfFetch } from "../csrf-fetch";

export type AdminRestrictionPayload = {
  readonly days: number | null;
  readonly reason: string;
  readonly status: "BANNED" | "RESTRICTED";
};

export async function fetchAdminSettings(date: string): Promise<readonly AdminPeriodSetting[] | "unauthorized"> {
  const response = await fetch(`/api/admin/period-settings?date=${date}`);
  if (response.status === 401 || response.status === 403) {
    return "unauthorized";
  }
  return AdminSettingsPayloadSchema.parse(await response.json()).periods;
}

export async function fetchAdminDashboard(date: string): Promise<readonly AdminDashboardPeriod[]> {
  const response = await fetch(`/api/admin/dashboard?date=${date}`);
  return AdminDashboardPayloadSchema.parse(await response.json()).periods;
}

export async function fetchAdminStatistics(input: { readonly from: string; readonly to: string }): Promise<AdminStatistics | null> {
  const params = new URLSearchParams({ from: input.from, to: input.to });
  const response = await fetch(`/api/admin/statistics?${params.toString()}`);
  if (!response.ok) {
    return null;
  }
  return AdminStatisticsPayloadSchema.parse(await response.json()).statistics;
}

export async function fetchAdminReservations(input: {
  readonly date: string;
  readonly query: string;
  readonly status: AdminReservationStatusFilter;
  readonly studyPeriod: AdminReservationStudyPeriodFilter;
  readonly userId?: string | null;
}): Promise<readonly AdminReservation[]> {
  const params = new URLSearchParams({
    date: input.date,
    query: input.query,
    status: input.status,
    studyPeriod: input.studyPeriod
  });
  if (input.userId) {
    params.set("userId", input.userId);
  }
  const response = await fetch(`/api/admin/reservations?${params.toString()}`);
  return AdminReservationsPayloadSchema.parse(await response.json()).reservations;
}

export async function fetchAdminUsers(input: {
  readonly query: string;
  readonly status: AdminUserStatusFilter;
}): Promise<readonly AdminUser[]> {
  const params = new URLSearchParams({ bookingStatus: input.status, query: input.query });
  const response = await fetch(`/api/admin/users?${params.toString()}`);
  return AdminUsersPayloadSchema.parse(await response.json()).users;
}

export async function fetchAdminUserDetail(userId: string): Promise<AdminUserDetail> {
  const response = await fetch(`/api/admin/users/${userId}`);
  return AdminUserDetailSchema.parse(await response.json());
}

export async function fetchAdminAuditActions(input: {
  readonly action: AdminAuditActionFilter;
  readonly query: string;
}): Promise<readonly AdminAuditAction[]> {
  const params = new URLSearchParams({ action: input.action, query: input.query });
  const response = await fetch(`/api/admin/actions?${params.toString()}`);
  return AdminAuditActionsPayloadSchema.parse(await response.json()).actions;
}

export async function saveAdminSettings(input: {
  readonly date: string;
  readonly periods: readonly AdminPeriodSetting[];
}): Promise<boolean> {
  const response = await csrfFetch("/api/admin/period-settings", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  return response.ok;
}

export async function sendClosedPeriodNotification(period: AdminDashboardPeriod, force: boolean): Promise<boolean> {
  const response = await csrfFetch("/api/admin/notifications/closed-periods/send", {
    body: JSON.stringify({ date: period.date, force, studyPeriod: period.studyPeriod }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  return response.ok;
}

export async function markReservationNoShow(reservationId: string): Promise<boolean> {
  const response = await csrfFetch(`/api/admin/reservations/${reservationId}/no-show`, {
    body: JSON.stringify({ days: 7, reason: "정보실 예약 노쇼" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  return response.ok;
}

export async function cancelAdminReservation(reservationId: string): Promise<boolean> {
  const response = await csrfFetch(`/api/admin/reservations/${reservationId}/cancel`, { method: "POST" });
  return response.ok;
}

export async function applyUserRestriction(userId: string, payload: AdminRestrictionPayload): Promise<boolean> {
  const response = await csrfFetch(`/api/admin/users/${userId}/restriction`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  return response.ok;
}

export async function removeUserRestriction(userId: string): Promise<boolean> {
  const response = await csrfFetch(`/api/admin/users/${userId}/restriction`, { method: "DELETE" });
  return response.ok;
}

export async function revokeUserSessions(userId: string): Promise<boolean> {
  const response = await csrfFetch(`/api/admin/users/${userId}/sessions/revoke`, {
    body: JSON.stringify({ reason: "관리자 세션 종료" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  return response.ok;
}

export function updatePeriodSetting(
  periods: readonly AdminPeriodSetting[],
  studyPeriod: StudyPeriod,
  patch: Partial<AdminPeriodSetting>
): readonly AdminPeriodSetting[] {
  return periods.map((period) => (period.studyPeriod === studyPeriod ? { ...period, ...patch } : period));
}
