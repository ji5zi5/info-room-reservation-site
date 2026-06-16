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
import { z } from "zod";

type JsonResponseSchema<T> = {
  readonly parse: (value: unknown) => T;
};

export type AdminReadResult<T> =
  | { readonly data: T; readonly kind: "ok" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unauthorized" };

export type AdminRestrictionPayload = {
  readonly days: number | null;
  readonly reason: string;
  readonly status: "BANNED" | "RESTRICTED" | "SHADOW_BANNED";
};

export async function fetchAdminSettings(date: string): Promise<AdminReadResult<readonly AdminPeriodSetting[]>> {
  const response = await fetch(`/api/admin/period-settings?date=${date}`);
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  const result = await readJsonResponse(response, AdminSettingsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.periods, kind: "ok" } : result;
}

export async function fetchAdminDashboard(date: string): Promise<AdminReadResult<readonly AdminDashboardPeriod[]>> {
  const response = await fetch(`/api/admin/dashboard?date=${date}`);
  const result = await readJsonResponse(response, AdminDashboardPayloadSchema);
  return result.kind === "ok" ? { data: result.data.periods, kind: "ok" } : result;
}

export async function fetchAdminStatistics(input: {
  readonly from: string;
  readonly to: string;
}): Promise<AdminReadResult<AdminStatistics | null>> {
  const params = new URLSearchParams({ from: input.from, to: input.to });
  const response = await fetch(`/api/admin/statistics?${params.toString()}`);
  const result = await readJsonResponse(response, AdminStatisticsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.statistics, kind: "ok" } : result;
}

export async function fetchAdminReservations(input: {
  readonly date: string;
  readonly query: string;
  readonly status: AdminReservationStatusFilter;
  readonly studyPeriod: AdminReservationStudyPeriodFilter;
  readonly userId?: string | null;
}): Promise<AdminReadResult<readonly AdminReservation[]>> {
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
  const result = await readJsonResponse(response, AdminReservationsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.reservations, kind: "ok" } : result;
}

export async function fetchAdminUsers(input: {
  readonly query: string;
  readonly status: AdminUserStatusFilter;
}): Promise<AdminReadResult<readonly AdminUser[]>> {
  const params = new URLSearchParams({ bookingStatus: input.status, query: input.query });
  const response = await fetch(`/api/admin/users?${params.toString()}`);
  const result = await readJsonResponse(response, AdminUsersPayloadSchema);
  return result.kind === "ok" ? { data: result.data.users, kind: "ok" } : result;
}

export async function fetchAdminUserDetail(userId: string): Promise<AdminReadResult<AdminUserDetail | null>> {
  const response = await fetch(`/api/admin/users/${userId}`);
  const result = await readJsonResponse(response, AdminUserDetailSchema);
  return result.kind === "ok" ? { data: result.data, kind: "ok" } : result;
}

export async function fetchAdminAuditActions(input: {
  readonly action: AdminAuditActionFilter;
  readonly query: string;
}): Promise<AdminReadResult<readonly AdminAuditAction[]>> {
  const params = new URLSearchParams({ action: input.action, query: input.query });
  const response = await fetch(`/api/admin/actions?${params.toString()}`);
  const result = await readJsonResponse(response, AdminAuditActionsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.actions, kind: "ok" } : result;
}

export async function saveAdminSettings(input: {
  readonly date: string;
  readonly periods: readonly AdminPeriodSetting[];
}): Promise<boolean> {
  const response = await csrfFetch("/api/admin/period-settings", {
    body: JSON.stringify(normalizeAdminSettingsInput(input)),
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
    body: JSON.stringify({ reason: "정보실 예약 노쇼" }),
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

async function readJsonResponse<T>(response: Response, schema: JsonResponseSchema<T>): Promise<AdminReadResult<T>> {
  if (!response.ok) {
    return { kind: "error", message: (await readErrorMessage(response)) ?? "관리자 데이터를 불러오지 못했습니다." };
  }
  const body = await response.text();
  if (!body.trim()) {
    return { kind: "error", message: "관리자 데이터 응답이 비어 있습니다." };
  }
  const payload = parseJsonBody(body);
  if (payload === null) {
    return { kind: "error", message: "관리자 데이터 응답 형식이 올바르지 않습니다." };
  }
  return { data: schema.parse(payload), kind: "ok" };
}

function parseJsonBody(body: string): unknown | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function normalizeAdminSettingsInput(input: {
  readonly date: string;
  readonly periods: readonly AdminPeriodSetting[];
}): {
  readonly date: string;
  readonly periods: readonly AdminPeriodSetting[];
} {
  return {
    date: input.date,
    periods: input.periods.map((period) => ({
      ...period,
      closeTime: normalizeTimeField(period.closeTime),
      openTime: normalizeTimeField(period.openTime)
    }))
  };
}

function normalizeTimeField(value: string): string {
  const trimmed = value.trim();
  const match = /^(?<hour>\d{1,2}):(?<minute>\d{2})$/u.exec(trimmed);
  const groups = match?.groups;
  if (!groups) {
    return trimmed;
  }
  const hour = groups.hour;
  const minute = groups.minute;
  if (hour === undefined || minute === undefined) {
    return trimmed;
  }
  return `${hour.padStart(2, "0")}:${minute}`;
}

async function readErrorMessage(response: Response): Promise<string | null> {
  const body = await response.text();
  if (!body.trim()) {
    return null;
  }
  const payload = parseJsonBody(body);
  const parsed = z.object({ error: z.object({ message: z.string() }).optional() }).safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.error?.message ?? null;
}
