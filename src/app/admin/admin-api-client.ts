import { z } from "zod";

import { readApiErrorMessage } from "../client-api-response";
import { csrfFetch } from "../csrf-fetch";
import {
  AdminNotificationSettingsPayloadSchema,
  AdminOperationsPayloadSchema,
  AdminSettingsPayloadSchema,
  type AdminDashboardPeriod,
  type AdminNotificationBacklogItem,
  type AdminNotificationReconciliationAction,
  type AdminNotificationSettings,
  type AdminOperationItem,
  type AdminOperationRepairAction,
  type AdminOperationsPayload,
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
const BulkCancellationStatusSchema = z.enum(["cancelled", "conflict", "invalid_status", "not_found"]);
const BulkCancellationSchema = z.object({
  results: z.array(z.object({
    reservationId: z.string().min(1),
    status: BulkCancellationStatusSchema
  }).strict()).max(50),
  summary: z.object({
    cancelled: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    invalidStatus: z.number().int().nonnegative(),
    notFound: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().max(50)
  }).strict()
}).strict().superRefine((value, context) => {
  const counts = { cancelled: 0, conflict: 0, invalid_status: 0, not_found: 0 };
  for (const result of value.results) {
    counts[result.status] += 1;
  }
  if (
    value.summary.total !== value.results.length ||
    value.summary.cancelled !== counts.cancelled ||
    value.summary.conflict !== counts.conflict ||
    value.summary.invalidStatus !== counts.invalid_status ||
    value.summary.notFound !== counts.not_found
  ) {
    context.addIssue({ code: "custom", message: "Bulk cancellation summary does not match item results." });
  }
});
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
const DiscordOperationRepairSchema = z.object({
  result: z.discriminatedUnion("kind", [
    z.object({ auditActionId: z.string(), kind: z.literal("repaired") }).strict(),
    z.object({ kind: z.literal("bound"), messageId: z.string() }).strict(),
    z.object({
      kind: z.literal("unresolved"),
      status: z.enum(["ERROR", "MULTIPLE", "PARTIAL", "UNIQUE", "ZERO_COMPLETE", "ZERO_PARTIAL"])
    }).strict()
  ])
}).strict();

export type SendClosedPeriodNotificationData = z.infer<typeof SendClosedPeriodNotificationSchema>;
export type ReconcileClosedPeriodNotificationData = z.infer<typeof ReconcileClosedPeriodNotificationSchema>;
export type CancelReservationData = z.infer<typeof CancelReservationSchema>;
export type BulkCancellationData = z.infer<typeof BulkCancellationSchema>;
export type BulkCancellationInput = {
  readonly mode: "execute" | "preview";
  readonly reason: string;
  readonly reservationIds: readonly string[];
};
export type NoShowReservationData = z.infer<typeof NoShowReservationSchema>;
export type ApplyRestrictionData = z.infer<typeof ApplyRestrictionSchema>;
export type RemoveRestrictionData = z.infer<typeof RemoveRestrictionSchema>;
export type DiscordOperationRepairData = z.infer<typeof DiscordOperationRepairSchema>;

export async function fetchAdminOperations(): Promise<
  { readonly data: AdminOperationsPayload; readonly kind: "ok" }
  | { readonly kind: "error"; readonly message: string }
> {
  try {
    const response = await fetch("/api/admin/operations");
    if (!response.ok) {
      return {
        kind: "error",
        message: (await readApiErrorMessage(response)) ?? "운영 작업을 불러오지 못했습니다."
      };
    }
    const body = await response.text();
    if (!body.trim()) {
      return { kind: "error", message: "운영 작업 응답 형식이 올바르지 않습니다." };
    }
    const parsedJson = parseJson(body);
    if (parsedJson.kind === "invalid") {
      return { kind: "error", message: "운영 작업 응답 형식이 올바르지 않습니다." };
    }
    const parsed = AdminOperationsPayloadSchema.safeParse(parsedJson.value);
    return parsed.success
      ? { data: parsed.data, kind: "ok" }
      : { kind: "error", message: "운영 작업 응답 형식이 올바르지 않습니다." };
  } catch {
    return { kind: "error", message: "운영 작업을 불러오지 못했습니다." };
  }
}

export async function repairDiscordOperation(
  item: AdminOperationItem,
  action: AdminOperationRepairAction,
  confirmation?: string
): Promise<AdminMutationResult<DiscordOperationRepairData>> {
  return performAdminMutation(() => csrfFetch("/api/admin/discord/reservations/reconcile", {
    body: JSON.stringify({
      action,
      ...(confirmation === undefined ? {} : { confirmation }),
      expectedControlEpoch: item.expectedControlEpoch,
      expectedState: item.expectedState,
      reservationId: item.reservationId
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), DiscordOperationRepairSchema, "Discord 작업 복구에 실패했습니다.");
}

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

export async function bulkCancelAdminReservations(
  input: BulkCancellationInput
): Promise<AdminMutationResult<BulkCancellationData>> {
  return performAdminMutation(() => csrfFetch("/api/admin/reservations/bulk-cancel", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), bulkCancellationResponseSchema(input.reservationIds), "예약 일괄 취소에 실패했습니다.");
}

function bulkCancellationResponseSchema(
  reservationIds: readonly string[]
): typeof BulkCancellationSchema {
  return BulkCancellationSchema.superRefine((value, context) => {
    if (
      value.results.length !== reservationIds.length ||
      value.results.some((result, index) => result.reservationId !== reservationIds[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Bulk cancellation results do not match the requested reservations."
      });
    }
  });
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

function parseJson(body: string): { readonly kind: "invalid" } | { readonly kind: "valid"; readonly value: unknown } {
  try {
    return { kind: "valid", value: JSON.parse(body) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: "invalid" };
    }
    throw error;
  }
}
