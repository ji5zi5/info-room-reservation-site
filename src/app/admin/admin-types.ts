import { z } from "zod";

import {
  ADMIN_RESERVATION_PERIOD_FILTERS,
  ADMIN_RESERVATION_STATUS_FILTERS,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter
} from "@/lib/admin-reservations";
import { ADMIN_AUDIT_ACTION_FILTERS, type AdminAuditActionFilter } from "@/lib/admin-audit-actions";
import { ADMIN_USER_STATUS_FILTERS, type AdminUserStatusFilter } from "@/lib/admin-users";

const StudyPeriodSchema = z.union([z.literal("EIGHTH"), z.literal("FIRST")]);

export const AdminPeriodSettingSchema = z.object({
  capacity: z.number(),
  closeTime: z.string(),
  confirmedCount: z.number(),
  date: z.string(),
  enabled: z.boolean(),
  label: z.string(),
  openTime: z.string(),
  remaining: z.number(),
  studyPeriod: StudyPeriodSchema
});

const AdminDashboardNotificationSchema = z.object({
  attempts: z.number(),
  lastError: z.string().nullable(),
  messageIds: z.array(z.string()),
  sentAt: z.string().nullable(),
  status: z.union([z.literal("FAILED"), z.literal("SENT")])
});

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

export const AdminReservationSchema = z.object({
  createdAt: z.string(),
  date: z.string(),
  id: z.string(),
  status: z.string(),
  studyPeriod: z.string(),
  user: z.object({
    bookingStatus: z.string(),
    id: z.string(),
    name: z.string(),
    role: z.string(),
    studentNumber: z.string()
  })
});

export const AdminUserSchema = z.object({
  bookingStatus: z.string(),
  generation: z.number(),
  id: z.string(),
  name: z.string(),
  restrictedUntil: z.string().nullable(),
  restrictionReason: z.string().nullable(),
  role: z.string(),
  studentNumber: z.string()
});

export const AdminSettingsPayloadSchema = z.object({ periods: z.array(AdminPeriodSettingSchema) });
export const AdminDashboardPayloadSchema = z.object({ periods: z.array(AdminDashboardPeriodSchema) });
export const AdminReservationsPayloadSchema = z.object({ reservations: z.array(AdminReservationSchema) });
export const AdminUsersPayloadSchema = z.object({ users: z.array(AdminUserSchema) });

const AdminAuditPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  studentNumber: z.string()
});

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
});

export const AdminAuditActionsPayloadSchema = z.object({ actions: z.array(AdminAuditActionSchema) });

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
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;
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
