import { z } from "zod";

import { AdminReservationSchema, AdminUserSchema } from "@/lib/admin-api-dto";
import {
  ADMIN_RESERVATION_PERIOD_FILTERS,
  ADMIN_RESERVATION_STATUS_FILTERS,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter
} from "@/lib/admin-reservations";
import { ADMIN_AUDIT_ACTION_FILTERS, type AdminAuditActionFilter } from "@/lib/admin-audit-actions";
import { ADMIN_USER_STATUS_FILTERS, type AdminUserStatusFilter } from "@/lib/admin-users";

const StudyPeriodSchema = z.union([z.literal("EIGHTH"), z.literal("FIRST")]);
const PeriodWindowStateSchema = z.union([z.literal("not_open_yet"), z.literal("open"), z.literal("closed")]);
const ClosedPeriodNotificationStatusSchema = z.union([
  z.literal("ABANDONED"),
  z.literal("FAILED"),
  z.literal("PENDING"),
  z.literal("PENDING_REVIEW"),
  z.literal("SENDING"),
  z.literal("SENT"),
  z.literal("UNKNOWN")
]);
const ReconciliationStatusSchema = z.union([
  z.literal("FAILED"),
  z.literal("PENDING_REVIEW"),
  z.literal("UNKNOWN")
]);

export const AdminPeriodSettingSchema = z.object({
  capacity: z.number(),
  closeTime: z.string(),
  confirmedCount: z.number(),
  date: z.string(),
  enabled: z.boolean(),
  label: z.string(),
  openTime: z.string(),
  remaining: z.number(),
  studyPeriod: StudyPeriodSchema,
  windowState: PeriodWindowStateSchema
});

export const AdminNotificationSettingsSchema = z.object({
  closedPeriodNotificationsEnabled: z.boolean(),
  id: z.literal("global"),
  reservationCreatedNotificationsEnabled: z.boolean()
});

const AdminDashboardNotificationSchema = z.object({
  attempts: z.number(),
  failureCode: z.string().nullable().optional(),
  lastError: z.string().nullable(),
  messageIds: z.array(z.string()),
  nextAttemptAt: z.string().nullable().optional(),
  sentAt: z.string().nullable(),
  status: ClosedPeriodNotificationStatusSchema,
  updatedAt: z.string()
});

export const AdminNotificationBacklogItemSchema = z
  .object({
    attempts: z.number(),
    date: z.string(),
    failureCode: z.string().nullable(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    status: ReconciliationStatusSchema,
    studyPeriod: StudyPeriodSchema,
    updatedAt: z.string()
  })
  .strict();

export const AdminDashboardPeriodSchema = AdminPeriodSettingSchema.extend({
  applicants: z.array(
    z.object({
      name: z.string(),
      reservationId: z.string(),
      studentNumber: z.string()
    })
  ),
  isClosed: z.boolean(),
  notification: AdminDashboardNotificationSchema.nullable()
});

export { AdminReservationSchema, AdminUserSchema } from "@/lib/admin-api-dto";

export const AdminSettingsPayloadSchema = z.object({ periods: z.array(AdminPeriodSettingSchema) });
export const AdminNotificationSettingsPayloadSchema = z.object({
  notificationSettings: AdminNotificationSettingsSchema
});
export const AdminDashboardPayloadSchema = z
  .object({
    notificationBacklog: z.array(AdminNotificationBacklogItemSchema),
    periods: z.array(AdminDashboardPeriodSchema)
  })
  .strict();

const AdminPageMetadataShape = { cutoff: z.string().datetime({ offset: true }), currentTotalCount: z.number().int().nonnegative(), expiresAt: z.string().datetime({ offset: true }), nextCursor: z.string().min(1).nullable() } as const;

export const AdminReservationsPayloadSchema = z.object({ ...AdminPageMetadataShape, items: z.array(AdminReservationSchema) }).strict();
export const AdminUsersPayloadSchema = z.object({ ...AdminPageMetadataShape, items: z.array(AdminUserSchema) }).strict();

const AdminAuditPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  studentNumber: z.string()
}).strict();

const AdminAuditActionCategorySchema = z.union([
  z.literal("NO_SHOW"),
  z.literal("NOTIFICATION"),
  z.literal("OTHER"),
  z.literal("RESERVATION"),
  z.literal("RESTRICTION"),
  z.literal("SESSION"),
  z.literal("SETTINGS")
]);

export const AdminAuditActionSchema = z.object({
  action: z.string(),
  actor: AdminAuditPersonSchema.nullable(),
  actorId: z.string().nullable(),
  after: z.string().nullable(),
  before: z.string().nullable(),
  category: AdminAuditActionCategorySchema,
  createdAt: z.string(),
  id: z.string(),
  reason: z.string().nullable(),
  reservationId: z.string().nullable(),
  targetUser: AdminAuditPersonSchema.nullable(),
  targetUserId: z.string().nullable()
}).strict();

export const AdminAuditActionsPayloadSchema = z.object({ ...AdminPageMetadataShape, items: z.array(AdminAuditActionSchema) }).strict();

const AdminCountSummarySchema = z.object({
  cancelledCount: z.number(),
  confirmedCount: z.number(),
  noShowCount: z.number(),
  totalCount: z.number()
});

const AdminPeriodStatisticsSchema = AdminCountSummarySchema.extend({
  capacity: z.number(),
  fillRate: z.number(),
  label: z.string(),
  studyPeriod: StudyPeriodSchema
});

const AdminDailyStatisticsSchema = AdminCountSummarySchema.extend({
  date: z.string()
});

const AdminRepeatedOffenderSchema = z.object({
  cancelledCount: z.number(),
  name: z.string(),
  noShowCount: z.number(),
  studentNumber: z.string(),
  totalIncidents: z.number(),
  userId: z.string()
});

export const AdminStatisticsSchema = z.object({
  dailyStats: z.array(AdminDailyStatisticsSchema),
  from: z.string(),
  periodStats: z.array(AdminPeriodStatisticsSchema),
  repeatedOffenders: z.array(AdminRepeatedOffenderSchema),
  to: z.string(),
  totals: AdminCountSummarySchema.extend({
    uniqueStudentCount: z.number()
  })
});

export const AdminStatisticsPayloadSchema = z.object({ statistics: AdminStatisticsSchema });

const AdminUserReservationSchema = z.object({
  createdAt: z.string(),
  date: z.string(),
  id: z.string(),
  reason: z.string().nullable(),
  status: z.string(),
  studyPeriod: z.string(),
  updatedAt: z.string(),
  userId: z.string()
});

const AdminAuditLogSchema = z.object({
  action: z.string(),
  actorId: z.string().nullable(),
  createdAt: z.string(),
  detail: z.string(),
  id: z.string()
});

const AdminActionLogSchema = z.object({
  action: z.string(),
  actorId: z.string().nullable(),
  after: z.string().nullable(),
  before: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  reason: z.string().nullable(),
  reservationId: z.string().nullable(),
  targetUserId: z.string().nullable()
});

const AdminUserSanctionSchema = z.object({
  actorId: z.string().nullable(),
  createdAt: z.string(),
  endsAt: z.string().nullable(),
  id: z.string(),
  reason: z.string(),
  revokedAt: z.string().nullable(),
  revokedById: z.string().nullable(),
  revokedReason: z.string().nullable(),
  sourceActionId: z.string().nullable(),
  startsAt: z.string(),
  status: z.string(),
  type: z.string()
});

const AdminUserReservationSummarySchema = z.object({
  cancelledCount: z.number(),
  confirmedCount: z.number(),
  noShowCount: z.number()
});

const AdminUserSanctionSummarySchema = z.object({
  activeCount: z.number(),
  permanentCount: z.number(),
  revokedCount: z.number(),
  totalCount: z.number()
});

const AdminUserSessionSummarySchema = z.object({
  activeCount: z.number(),
  expiredCount: z.number(),
  totalCount: z.number()
});

export const AdminUserDetailSchema = z.object({
  adminActions: z.array(AdminActionLogSchema),
  auditLogs: z.array(AdminAuditLogSchema),
  currentReservations: z.array(AdminUserReservationSchema),
  reservationHistory: z.array(AdminUserReservationSchema),
  sanctions: z.array(AdminUserSanctionSchema),
  sanctionSummary: AdminUserSanctionSummarySchema,
  sessionSummary: AdminUserSessionSummarySchema,
  summary: AdminUserReservationSummarySchema,
  user: AdminUserSchema.extend({
    createdAt: z.string(),
    updatedAt: z.string()
  })
});

export type AdminDashboardPeriod = z.infer<typeof AdminDashboardPeriodSchema>;
export type AdminDashboardPayload = z.infer<typeof AdminDashboardPayloadSchema>;
export type AdminNotificationBacklogItem = z.infer<typeof AdminNotificationBacklogItemSchema>;
export type AdminNotificationReconciliationAction = "abandon" | "confirm_sent" | "retry";
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;
export type AdminNotificationSettings = z.input<typeof AdminNotificationSettingsSchema>;
export type AdminPeriodSetting = z.infer<typeof AdminPeriodSettingSchema>;
export type AdminReservation = z.infer<typeof AdminReservationSchema>;
export type AdminStatistics = z.infer<typeof AdminStatisticsSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;
export type StudyPeriod = z.infer<typeof StudyPeriodSchema>;
export type {
  AdminAuditActionFilter,
  AdminReservationStatusFilter,
  AdminReservationStudyPeriodFilter,
  AdminUserStatusFilter
};
export {
  ADMIN_AUDIT_ACTION_FILTERS,
  ADMIN_RESERVATION_PERIOD_FILTERS,
  ADMIN_RESERVATION_STATUS_FILTERS,
  ADMIN_USER_STATUS_FILTERS
};
