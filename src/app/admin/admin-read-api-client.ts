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
  readonly safeParse: (value: unknown) =>
    | { readonly data: T; readonly success: true }
    | { readonly success: false };
};

export type AdminReadPage<T> = {
  readonly cutoff: string;
  readonly currentTotalCount: number;
  readonly expiresAt: string;
  readonly hasHiddenPrevious?: boolean;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

export const ADMIN_VISIBLE_ITEM_LIMIT = 100;

export type AdminReadResult<T> =
  | { readonly data: T; readonly kind: "ok" }
  | { readonly code: string | null; readonly kind: "error"; readonly message: string }
  | { readonly kind: "unauthorized" };

export type AdminReadOptions = {
  readonly signal?: AbortSignal;
};

export function mergeAdminReadPages<T extends { readonly id: string }>(
  current: AdminReadPage<T> | null,
  incoming: AdminReadPage<T>,
  mode: "append" | "replace"
): AdminReadPage<T> {
  if (mode === "replace" || current === null) {
    return { ...incoming, hasHiddenPrevious: false };
  }
  if (incoming.items.length === 0 && incoming.nextCursor === null && current.nextCursor !== null) {
    return {
      ...current,
      currentTotalCount: incoming.currentTotalCount
    };
  }
  const itemsById = new Map(current.items.map((item) => [item.id, item]));
  for (const item of incoming.items) {
    itemsById.set(item.id, item);
  }
  const mergedItems = [...itemsById.values()];
  const hasHiddenPrevious = current.hasHiddenPrevious === true || mergedItems.length > ADMIN_VISIBLE_ITEM_LIMIT;
  return {
    ...incoming,
    hasHiddenPrevious,
    items: hasHiddenPrevious ? mergedItems.slice(-ADMIN_VISIBLE_ITEM_LIMIT) : mergedItems
  };
}

export function buildAdminReservationExportUrl(input: {
  readonly date: string;
  readonly query: string;
  readonly status: AdminReservationStatusFilter;
  readonly studyPeriod: AdminReservationStudyPeriodFilter;
}): string {
  return `/api/admin/exports/reservations?${new URLSearchParams({
    date: input.date,
    query: input.query,
    status: input.status,
    studyPeriod: input.studyPeriod
  }).toString()}`;
}

export function buildAdminAuditExportUrl(input: {
  readonly action: AdminAuditActionFilter;
  readonly query: string;
}): string {
  return `/api/admin/exports/actions?${new URLSearchParams({
    action: input.action,
    query: input.query
  }).toString()}`;
}

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
    readonly cursor?: string;
    readonly date: string;
    readonly query: string;
    readonly reservationId?: string;
    readonly status: AdminReservationStatusFilter;
    readonly studyPeriod: AdminReservationStudyPeriodFilter;
    readonly userId?: string | null;
  },
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminReadPage<AdminReservation>>> {
  const params = new URLSearchParams({
    date: input.date,
    query: input.query,
    status: input.status,
    studyPeriod: input.studyPeriod
  });
  if (input.userId) {
    params.set("userId", input.userId);
  }
  if (input.reservationId) {
    params.set("reservationId", input.reservationId);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  const response = await fetch(`/api/admin/reservations?${params.toString()}`, options);
  return readJsonResponse(response, AdminReservationsPayloadSchema);
}

export async function fetchAdminUsers(
  input: {
    readonly cursor?: string;
    readonly query: string;
    readonly status: AdminUserStatusFilter;
    readonly userId?: string;
  },
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminReadPage<AdminUser>>> {
  const params = new URLSearchParams({ bookingStatus: input.status, query: input.query });
  if (input.userId) {
    params.set("userId", input.userId);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  const response = await fetch(`/api/admin/users?${params.toString()}`, options);
  return readJsonResponse(response, AdminUsersPayloadSchema);
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
  input: {
    readonly action: AdminAuditActionFilter;
    readonly actionId?: string;
    readonly cursor?: string;
    readonly query: string;
  },
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminReadPage<AdminAuditAction>>> {
  const params = new URLSearchParams({ action: input.action, query: input.query });
  if (input.actionId) {
    params.set("actionId", input.actionId);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  const response = await fetch(`/api/admin/actions?${params.toString()}`, options);
  return readJsonResponse(response, AdminAuditActionsPayloadSchema);
}

async function readJsonResponse<T>(
  response: Response,
  schema: JsonResponseSchema<T>
): Promise<AdminReadResult<T>> {
  if (!response.ok) {
    const details = await readErrorDetails(response);
    return {
      code: details?.code ?? null,
      kind: "error",
      message: details?.message ?? "관리자 데이터를 불러오지 못했습니다."
    };
  }
  const body = await response.text();
  if (!body.trim()) {
    return { code: null, kind: "error", message: "관리자 데이터 응답이 비어 있습니다." };
  }
  const payload = parseJsonBody(body);
  if (payload === null) {
    return { code: null, kind: "error", message: "관리자 데이터 응답 형식이 올바르지 않습니다." };
  }
  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { data: parsed.data, kind: "ok" }
    : { code: null, kind: "error", message: "관리자 데이터 응답 형식이 올바르지 않습니다." };
}

function parseJsonBody(body: string): unknown | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function readErrorDetails(response: Response): Promise<{
  readonly code: string | null;
  readonly message: string;
} | null> {
  const body = await response.text();
  if (!body.trim()) {
    return null;
  }
  const payload = parseJsonBody(body);
  const parsed = z.object({
    error: z.object({ code: z.string().optional(), message: z.string() }).optional()
  }).safeParse(payload);
  const error = parsed.success ? parsed.data.error : undefined;
  return error ? { code: error.code ?? null, message: error.message } : null;
}
