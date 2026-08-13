import { z } from "zod";

import { readApiErrorMessage } from "../client-api-response";
import { csrfFetch } from "../csrf-fetch";
import {
  AdminNotificationSettingsPayloadSchema,
  AdminSettingsPayloadSchema,
  type AdminDashboardPeriod,
  type AdminNotificationBacklogItem,
  type AdminNotificationReconciliationAction,
  type AdminNotificationSettings,
  type AdminPeriodSetting,
  type StudyPeriod
} from "./admin-types";
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
  type AdminReadPage,
  type AdminReadResult
} from "./admin-read-api-client";

export type AdminRestrictionPayload = {
  readonly days: number | null;
  readonly reason: string;
  readonly shadowBanProfile?: ShadowBanProfile;
  readonly status: "BANNED" | "RESTRICTED" | "SHADOW_BANNED";
};

export type AdminMutationResult<T> =
  | { readonly data: T; readonly kind: "ok" }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly retryAfterMs: number | null;
      readonly retryable: boolean;
      readonly status: number | null;
    };

const DeliverySchema = z.object({
  date: z.string(),
  failureCode: z.string().nullable().optional(),
  kind: z.string(),
  lastError: z.string().nullable().optional(),
  messageIds: z.array(z.string()).optional(),
  nextAttemptAt: z.string().nullable().optional(),
  status: z.enum(["ABANDONED", "FAILED", "PENDING", "PENDING_REVIEW", "SENDING", "SENT", "UNKNOWN"]),
  studyPeriod: z.enum(["EIGHTH", "FIRST"]),
  updatedAt: z.string().optional()
}).passthrough();

const SendClosedPeriodNotificationSchema = z.discriminatedUnion("kind", [
  z.object({ delivery: DeliverySchema, kind: z.literal("failed") }),
  z.object({ delivery: DeliverySchema, kind: z.literal("sent") }),
  z.object({ delivery: DeliverySchema, kind: z.literal("unknown") })
]);

const ReconcileClosedPeriodNotificationSchema = z.discriminatedUnion("kind", [
  z.object({ delivery: DeliverySchema, kind: z.literal("abandoned"), previousStatus: z.enum(["FAILED", "PENDING_REVIEW", "UNKNOWN"]) }),
  z.object({ delivery: DeliverySchema, kind: z.literal("confirmed"), previousStatus: z.enum(["FAILED", "PENDING_REVIEW", "UNKNOWN"]) }),
  z.object({ delivery: DeliverySchema, kind: z.literal("failed"), previousStatus: z.enum(["FAILED", "PENDING_REVIEW", "UNKNOWN"]) }),
  z.object({ delivery: DeliverySchema, kind: z.literal("sent"), previousStatus: z.enum(["FAILED", "PENDING_REVIEW", "UNKNOWN"]) }),
  z.object({ delivery: DeliverySchema, kind: z.literal("unknown"), previousStatus: z.enum(["FAILED", "PENDING_REVIEW", "UNKNOWN"]) })
]);

const ReservationMutationSchema = z.object({
  createdAt: z.string(),
  date: z.string(),
  id: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  studyPeriod: z.string(),
  updatedAt: z.string(),
  userId: z.string()
}).passthrough();

const UserMutationSchema = z.object({
  bookingStatus: z.string(),
  generation: z.number(),
  id: z.string(),
  name: z.string(),
  restrictedUntil: z.string().nullable(),
  restrictionReason: z.string().nullable(),
  role: z.string(),
  shadowBanProfile: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
  studentNumber: z.string()
}).passthrough();

const CancelReservationSchema = z.object({ reservation: ReservationMutationSchema });
const NoShowReservationSchema = z.object({
  cancelledFutureReservationCount: z.number().int().nonnegative(),
  reservation: ReservationMutationSchema,
  user: UserMutationSchema
});
const ApplyRestrictionSchema = z.object({
  cancelledFutureReservationCount: z.number().int().nonnegative(),
  idempotent: z.boolean().optional(),
  user: UserMutationSchema
});
const RemoveRestrictionSchema = z.object({ user: UserMutationSchema });

export type SendClosedPeriodNotificationData = z.infer<typeof SendClosedPeriodNotificationSchema>;
export type ReconcileClosedPeriodNotificationData = z.infer<typeof ReconcileClosedPeriodNotificationSchema>;
export type CancelReservationData = z.infer<typeof CancelReservationSchema>;
export type NoShowReservationData = z.infer<typeof NoShowReservationSchema>;
export type ApplyRestrictionData = z.infer<typeof ApplyRestrictionSchema>;
export type RemoveRestrictionData = z.infer<typeof RemoveRestrictionSchema>;

export async function saveAdminSettings(input: {
  readonly date: string;
  readonly periods: readonly AdminPeriodSetting[];
}): Promise<AdminMutationResult<z.infer<typeof AdminSettingsPayloadSchema>>> {
  return performAdminMutation(() => csrfFetch("/api/admin/period-settings", {
    body: JSON.stringify(normalizeAdminSettingsInput(input)),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }), AdminSettingsPayloadSchema, "시간대 설정 저장에 실패했습니다.");
}

export async function saveAdminNotificationSettings(
  input: AdminNotificationSettings
): Promise<AdminMutationResult<z.infer<typeof AdminNotificationSettingsPayloadSchema>>> {
  return performAdminMutation(() => csrfFetch("/api/admin/notification-settings", {
    body: JSON.stringify({
      notificationSettings: {
        closedPeriodNotificationsEnabled: input.closedPeriodNotificationsEnabled,
        reservationCreatedNotificationsEnabled: input.reservationCreatedNotificationsEnabled
      }
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }), AdminNotificationSettingsPayloadSchema, "알림 설정 저장에 실패했습니다.");
}

export async function sendClosedPeriodNotification(
  period: AdminDashboardPeriod
): Promise<AdminMutationResult<SendClosedPeriodNotificationData>> {
  return performAdminMutation(() => csrfFetch("/api/admin/notifications/closed-periods/send", {
    body: JSON.stringify({ date: period.date, studyPeriod: period.studyPeriod }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), SendClosedPeriodNotificationSchema, "마감 명단 전송에 실패했습니다.");
}

export async function markReservationNoShow(
  reservationId: string
): Promise<AdminMutationResult<NoShowReservationData>> {
  return performAdminMutation(() => csrfFetch(`/api/admin/reservations/${reservationId}/no-show`, {
    body: JSON.stringify({ reason: "정보실 예약 노쇼" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), NoShowReservationSchema, "노쇼 처리에 실패했습니다.");
}

export async function cancelAdminReservation(
  reservationId: string,
  reason: string
): Promise<AdminMutationResult<CancelReservationData>> {
  return performAdminMutation(() => csrfFetch(`/api/admin/reservations/${reservationId}/cancel`, {
    body: JSON.stringify({ reason }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), CancelReservationSchema, "예약 취소에 실패했습니다.");
}

export async function reconcileClosedPeriodNotification(
  item: AdminNotificationBacklogItem,
  action: AdminNotificationReconciliationAction
): Promise<AdminMutationResult<ReconcileClosedPeriodNotificationData>> {
  return performAdminMutation(() => csrfFetch("/api/admin/notifications/closed-periods/reconcile", {
    body: JSON.stringify({
      action,
      date: item.date,
      studyPeriod: item.studyPeriod
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), ReconcileClosedPeriodNotificationSchema, "알림 상태 조정에 실패했습니다.");
}

export async function applyUserRestriction(
  userId: string,
  payload: AdminRestrictionPayload
): Promise<AdminMutationResult<ApplyRestrictionData>> {
  return performAdminMutation(() => csrfFetch(`/api/admin/users/${userId}/restriction`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), ApplyRestrictionSchema, "학생 제재 적용에 실패했습니다.");
}

export async function removeUserRestriction(
  userId: string
): Promise<AdminMutationResult<RemoveRestrictionData>> {
  return performAdminMutation(
    () => csrfFetch(`/api/admin/users/${userId}/restriction`, { method: "DELETE" }),
    RemoveRestrictionSchema,
    "학생 제재 해제에 실패했습니다."
  );
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

type MutationResponseSchema<T> = {
  readonly safeParse: (value: unknown) =>
    | { readonly data: T; readonly success: true }
    | { readonly success: false };
};

async function performAdminMutation<T>(
  request: () => Promise<Response>,
  schema: MutationResponseSchema<T>,
  fallbackMessage: string
): Promise<AdminMutationResult<T>> {
  try {
    return await parseAdminMutationResponse(await request(), schema, fallbackMessage);
  } catch {
    return {
      kind: "error",
      message: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
      retryAfterMs: null,
      retryable: true,
      status: null
    };
  }
}

async function parseAdminMutationResponse<T>(
  response: Response,
  schema: MutationResponseSchema<T>,
  fallbackMessage: string
): Promise<AdminMutationResult<T>> {
  if (!response.ok) {
    const retryable = response.status === 429 || response.status === 503;
    return {
      kind: "error",
      message: (await readApiErrorMessage(response)) ?? fallbackMessage,
      retryAfterMs: retryable ? parseRetryAfter(response.headers.get("Retry-After"), Date.now()) : null,
      retryable,
      status: response.status
    };
  }

  const body = await response.text();
  if (!body.trim()) {
    return mutationPayloadError(response.status, fallbackMessage);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return mutationPayloadError(response.status, fallbackMessage);
    }
    throw error;
  }
  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { data: parsed.data, kind: "ok" }
    : mutationPayloadError(response.status, fallbackMessage);
}

function mutationPayloadError(status: number, message: string): AdminMutationResult<never> {
  return { kind: "error", message, retryAfterMs: null, retryable: false, status };
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
  }
  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) {
    return null;
  }
  const delay = retryAt - nowMs;
  return delay > 0 ? delay : null;
}
