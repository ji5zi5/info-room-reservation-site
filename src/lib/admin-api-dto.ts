import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { parseShadowBanProfile } from "./shadow-ban-profile";

export const ADMIN_USER_LIST_SELECT = {
  bookingStatus: true,
  generation: true,
  id: true,
  name: true,
  restrictedUntil: true,
  restrictionReason: true,
  role: true,
  shadowBanProfile: true,
  studentNumber: true
} as const satisfies Prisma.UserSelect;

export const ADMIN_RESERVATION_LIST_SELECT = {
  createdAt: true,
  date: true,
  id: true,
  reason: true,
  status: true,
  studyPeriod: true,
  user: {
    select: {
      bookingStatus: true,
      id: true,
      name: true,
      role: true,
      studentNumber: true
    }
  }
} as const satisfies Prisma.ReservationSelect;

export const AdminUserSchema = z
  .object({
    bookingStatus: z.string(),
    generation: z.number(),
    id: z.string(),
    name: z.string(),
    restrictedUntil: z.string().nullable(),
    restrictionReason: z.string().nullable(),
    role: z.string(),
    shadowBanProfile: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
    studentNumber: z.string()
  })
  .strict();

export const AdminReservationSchema = z
  .object({
    createdAt: z.string(),
    date: z.string(),
    id: z.string(),
    reason: z.string().nullable(),
    status: z.string(),
    studyPeriod: z.string(),
    user: z
      .object({
        bookingStatus: z.string(),
        id: z.string(),
        name: z.string(),
        role: z.string(),
        studentNumber: z.string()
      })
      .strict()
  })
  .strict();

type AdminUserDtoSource = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictedUntil: Date | null;
  readonly restrictionReason: string | null;
  readonly role: string;
  readonly shadowBanProfile: string | null | undefined;
  readonly studentNumber: string;
};

type AdminReservationDtoSource = {
  readonly createdAt: Date;
  readonly date: string;
  readonly id: string;
  readonly reason: string | null;
  readonly status: string;
  readonly studyPeriod: string;
  readonly user: {
    readonly bookingStatus: string;
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly studentNumber: string;
  };
};

export function toAdminUserDto(user: AdminUserDtoSource): z.infer<typeof AdminUserSchema> {
  return AdminUserSchema.parse({
    bookingStatus: user.bookingStatus,
    generation: user.generation,
    id: user.id,
    name: user.name,
    restrictedUntil: user.restrictedUntil?.toISOString() ?? null,
    restrictionReason: user.restrictionReason,
    role: user.role,
    shadowBanProfile: parseShadowBanProfile(user.shadowBanProfile),
    studentNumber: user.studentNumber
  });
}

export function toAdminReservationDto(
  reservation: AdminReservationDtoSource
): z.infer<typeof AdminReservationSchema> {
  return AdminReservationSchema.parse({
    createdAt: reservation.createdAt.toISOString(),
    date: reservation.date,
    id: reservation.id,
    reason: reservation.reason,
    status: reservation.status,
    studyPeriod: reservation.studyPeriod,
    user: {
      bookingStatus: reservation.user.bookingStatus,
      id: reservation.user.id,
      name: reservation.user.name,
      role: reservation.user.role,
      studentNumber: reservation.user.studentNumber
    }
  });
}
