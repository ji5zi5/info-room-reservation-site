import { z } from "zod";

import { ADMIN_RESERVATION_STATUS_FILTERS, type AdminReservationStatusFilter } from "@/lib/admin-reservations";
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
  date: z.string(),
  id: z.string(),
  status: z.string(),
  studyPeriod: z.string(),
  user: z.object({
    bookingStatus: z.string(),
    id: z.string(),
    name: z.string(),
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

export type AdminDashboardPeriod = z.infer<typeof AdminDashboardPeriodSchema>;
export type AdminPeriodSetting = z.infer<typeof AdminPeriodSettingSchema>;
export type AdminReservation = z.infer<typeof AdminReservationSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type StudyPeriod = z.infer<typeof StudyPeriodSchema>;
export type { AdminReservationStatusFilter, AdminUserStatusFilter };
export { ADMIN_RESERVATION_STATUS_FILTERS, ADMIN_USER_STATUS_FILTERS };
