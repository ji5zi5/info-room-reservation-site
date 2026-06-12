import { z } from "zod";

import {
  ADMIN_RESERVATION_PERIOD_FILTERS,
  ADMIN_RESERVATION_STATUS_FILTERS,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter
} from "@/lib/admin-reservations";
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

const AdminUserReservationSummarySchema = z.object({
  cancelledCount: z.number(),
  confirmedCount: z.number(),
  noShowCount: z.number()
});

export const AdminUserDetailSchema = z.object({
  auditLogs: z.array(AdminAuditLogSchema),
  currentReservations: z.array(AdminUserReservationSchema),
  reservationHistory: z.array(AdminUserReservationSchema),
  summary: AdminUserReservationSummarySchema,
  user: AdminUserSchema.extend({
    createdAt: z.string(),
    updatedAt: z.string()
  })
});

export type AdminDashboardPeriod = z.infer<typeof AdminDashboardPeriodSchema>;
export type AdminPeriodSetting = z.infer<typeof AdminPeriodSettingSchema>;
export type AdminReservation = z.infer<typeof AdminReservationSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;
export type StudyPeriod = z.infer<typeof StudyPeriodSchema>;
export type { AdminReservationStatusFilter, AdminReservationStudyPeriodFilter, AdminUserStatusFilter };
export { ADMIN_RESERVATION_PERIOD_FILTERS, ADMIN_RESERVATION_STATUS_FILTERS, ADMIN_USER_STATUS_FILTERS };
