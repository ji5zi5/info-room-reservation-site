import { z } from "zod";

import {
  AdminAuditActionsPayloadSchema,
  AdminDashboardPayloadSchema,
  AdminNotificationSettingsPayloadSchema,
  AdminReservationsPayloadSchema,
  AdminSettingsPayloadSchema,
  AdminStatisticsPayloadSchema,
  AdminUserDetailSchema,
  AdminUsersPayloadSchema,
  type AdminAuditAction,
  type AdminAuditActionFilter,
  type AdminDashboardPayload,
  type AdminNotificationSettings,
  type AdminPeriodSetting,
  type AdminReservation,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter,
  type AdminStatistics,
  type AdminUser,
  type AdminUserDetail,
  type AdminUserStatusFilter
} from "./admin-types";

type JsonResponseSchema<T> = {
  readonly parse: (value: unknown) => T;
};

export type AdminReadResult<T> =
  | { readonly data: T; readonly kind: "ok" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unauthorized" };

export type AdminReadOptions = {
  readonly signal?: AbortSignal;
};

export async function fetchAdminSettings(
  date: string,
  options?: AdminReadOptions
): Promise<AdminReadResult<readonly AdminPeriodSetting[]>> {
  const response = await fetch(`/api/admin/period-settings?date=${date}`, options);
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  const result = await readJsonResponse(response, AdminSettingsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.periods, kind: "ok" } : result;
}

export async function fetchAdminNotificationSettings(
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminNotificationSettings>> {
  const response = await fetch("/api/admin/notification-settings", options);
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  const result = await readJsonResponse(response, AdminNotificationSettingsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.notificationSettings, kind: "ok" } : result;
}

export async function fetchAdminDashboard(
  date: string,
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminDashboardPayload>> {
  const response = await fetch(`/api/admin/dashboard?date=${date}`, options);
  return readJsonResponse(response, AdminDashboardPayloadSchema);
}

export async function fetchAdminStatistics(
  input: { readonly from: string; readonly to: string },
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminStatistics | null>> {
  const params = new URLSearchParams({ from: input.from, to: input.to });
  const response = await fetch(`/api/admin/statistics?${params.toString()}`, options);
  const result = await readJsonResponse(response, AdminStatisticsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.statistics, kind: "ok" } : result;
}

export async function fetchAdminReservations(
  input: {
    readonly date: string;
    readonly query: string;
    readonly status: AdminReservationStatusFilter;
    readonly studyPeriod: AdminReservationStudyPeriodFilter;
    readonly userId?: string | null;
  },
  options?: AdminReadOptions
): Promise<AdminReadResult<readonly AdminReservation[]>> {
  const params = new URLSearchParams({
    date: input.date,
    query: input.query,
    status: input.status,
    studyPeriod: input.studyPeriod
  });
  if (input.userId) {
    params.set("userId", input.userId);
  }
  const response = await fetch(`/api/admin/reservations?${params.toString()}`, options);
  const result = await readJsonResponse(response, AdminReservationsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.reservations, kind: "ok" } : result;
}

export async function fetchAdminUsers(
  input: { readonly query: string; readonly status: AdminUserStatusFilter },
  options?: AdminReadOptions
): Promise<AdminReadResult<readonly AdminUser[]>> {
  const params = new URLSearchParams({ bookingStatus: input.status, query: input.query });
  const response = await fetch(`/api/admin/users?${params.toString()}`, options);
  const result = await readJsonResponse(response, AdminUsersPayloadSchema);
  return result.kind === "ok" ? { data: result.data.users, kind: "ok" } : result;
}

export async function fetchAdminUserDetail(
  userId: string,
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminUserDetail | null>> {
  const response = await fetch(`/api/admin/users/${userId}`, options);
  const result = await readJsonResponse(response, AdminUserDetailSchema);
  return result.kind === "ok" ? { data: result.data, kind: "ok" } : result;
}

export async function fetchAdminAuditActions(
  input: { readonly action: AdminAuditActionFilter; readonly query: string },
  options?: AdminReadOptions
): Promise<AdminReadResult<readonly AdminAuditAction[]>> {
  const params = new URLSearchParams({ action: input.action, query: input.query });
  const response = await fetch(`/api/admin/actions?${params.toString()}`, options);
  const result = await readJsonResponse(response, AdminAuditActionsPayloadSchema);
  return result.kind === "ok" ? { data: result.data.actions, kind: "ok" } : result;
}

async function readJsonResponse<T>(
  response: Response,
  schema: JsonResponseSchema<T>
): Promise<AdminReadResult<T>> {
  if (!response.ok) {
    return {
      kind: "error",
      message: (await readErrorMessage(response)) ?? "관리자 데이터를 불러오지 못했습니다."
    };
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

async function readErrorMessage(response: Response): Promise<string | null> {
  const body = await response.text();
  if (!body.trim()) {
    return null;
  }
  const payload = parseJsonBody(body);
  const parsed = z.object({ error: z.object({ message: z.string() }).optional() }).safeParse(payload);
  return parsed.success ? parsed.data.error?.message ?? null : null;
}
