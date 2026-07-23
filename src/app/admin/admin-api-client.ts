import {
  type AdminDashboardPeriod,
  type AdminNotificationBacklogItem,
  type AdminNotificationReconciliationAction,
  type AdminNotificationSettings,
  type AdminPeriodSetting,
  type StudyPeriod
} from "./admin-types";
import { csrfFetch } from "../csrf-fetch";
import type { ShadowBanProfile } from "@/lib/shadow-ban-profile";

export {
  fetchAdminAuditActions,
  fetchAdminDashboard,
  fetchAdminNotificationSettings,
  fetchAdminReservations,
  fetchAdminSettings,
  fetchAdminStatistics,
  fetchAdminUserDetail,
  fetchAdminUsers,
  type AdminReadOptions,
  type AdminReadResult
} from "./admin-read-api-client";

export type AdminRestrictionPayload = {
  readonly days: number | null;
  readonly reason: string;
  readonly shadowBanProfile?: ShadowBanProfile;
  readonly status: "BANNED" | "RESTRICTED" | "SHADOW_BANNED";
};

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

export async function saveAdminNotificationSettings(input: AdminNotificationSettings): Promise<boolean> {
  const response = await csrfFetch("/api/admin/notification-settings", {
    body: JSON.stringify({
      notificationSettings: {
        closedPeriodNotificationsEnabled: input.closedPeriodNotificationsEnabled,
        reservationCreatedNotificationsEnabled: input.reservationCreatedNotificationsEnabled
      }
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  return response.ok;
}

export async function sendClosedPeriodNotification(period: AdminDashboardPeriod): Promise<boolean> {
  const response = await csrfFetch("/api/admin/notifications/closed-periods/send", {
    body: JSON.stringify({ date: period.date, studyPeriod: period.studyPeriod }),
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

export async function cancelAdminReservation(reservationId: string, reason: string): Promise<boolean> {
  const response = await csrfFetch(`/api/admin/reservations/${reservationId}/cancel`, {
    body: JSON.stringify({ reason }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  return response.ok;
}

export async function reconcileClosedPeriodNotification(
  item: AdminNotificationBacklogItem,
  action: AdminNotificationReconciliationAction
): Promise<boolean> {
  const response = await csrfFetch("/api/admin/notifications/closed-periods/reconcile", {
    body: JSON.stringify({
      action,
      date: item.date,
      studyPeriod: item.studyPeriod
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
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
