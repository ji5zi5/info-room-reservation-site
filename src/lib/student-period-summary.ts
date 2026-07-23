import { z } from "zod";

import type { PeriodSummary } from "./period-settings";

export const StudentPeriodSummarySchema = z
  .object({
    capacity: z.number(),
    closeTime: z.string(),
    confirmedCount: z.number(),
    date: z.string(),
    enabled: z.boolean(),
    label: z.string(),
    myReservationId: z.string().nullable(),
    openTime: z.string(),
    remaining: z.number(),
    studyPeriod: z.enum(["EIGHTH", "FIRST"]),
    windowState: z.enum(["closed", "not_open_yet", "open"])
  });

export type StudentPeriodSummary = z.infer<typeof StudentPeriodSummarySchema>;

export const StudentPeriodWeekPeriodSchema = z
  .object({
    studyPeriod: z.enum(["EIGHTH", "FIRST"]),
    openTime: z.string(),
    closeTime: z.string(),
    capacity: z.number(),
    reservedCount: z.number(),
    enabled: z.boolean(),
    availability: z.number(),
    myReservationId: z.string().nullable()
  })
  .strict();

export const StudentPeriodWeekPayloadSchema = z
  .object({
    dates: z.array(
      z
        .object({
          date: z.string(),
          periods: z.array(StudentPeriodWeekPeriodSchema)
        })
        .strict()
    )
  })
  .strict();

export type StudentPeriodWeekPayload = z.infer<typeof StudentPeriodWeekPayloadSchema>;
export type StudentPeriodWeekPeriod = z.infer<typeof StudentPeriodWeekPeriodSchema>;

export function toStudentPeriodSummary(period: PeriodSummary): StudentPeriodSummary {
  return StudentPeriodSummarySchema.parse({
    capacity: period.capacity,
    closeTime: period.closeTime,
    confirmedCount: period.confirmedCount,
    date: period.date,
    enabled: period.enabled,
    label: period.label,
    myReservationId: period.myReservationId,
    openTime: period.openTime,
    remaining: period.remaining,
    studyPeriod: period.studyPeriod,
    windowState: period.windowState
  });
}

export function toStudentPeriodWeekPeriod(period: PeriodSummary): StudentPeriodWeekPeriod {
  return StudentPeriodWeekPeriodSchema.parse({
    studyPeriod: period.studyPeriod,
    openTime: period.openTime,
    closeTime: period.closeTime,
    capacity: period.capacity,
    reservedCount: period.confirmedCount,
    enabled: period.enabled,
    availability: period.remaining,
    myReservationId: period.myReservationId
  });
}
