import { z } from "zod";

import type { PeriodSummary } from "@/components/reservation-period-card";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type LoginPayload = {
  readonly errorMessage: string | null;
  readonly user: ReservationSidebarUser | null;
};

const ErrorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string()
    })
    .optional()
});

const ReservationSidebarUserSchema = z.object({
  bookingStatus: z.string(),
  generation: z.number(),
  id: z.string(),
  name: z.string(),
  restrictedUntil: z.string().nullable(),
  role: z.string(),
  studentNumber: z.string()
});

const PeriodApplicantSchema = z.object({
  name: z.string(),
  reservationId: z.string(),
  studentNumber: z.string()
});

const PeriodSummarySchema = z.object({
  applicants: z.array(PeriodApplicantSchema),
  capacity: z.number(),
  closeTime: z.string(),
  confirmedCount: z.number(),
  date: z.string(),
  enabled: z.boolean(),
  label: z.string(),
  myReservationId: z.string().nullable(),
  openTime: z.string(),
  remaining: z.number(),
  studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")]),
  windowState: z.union([z.literal("closed"), z.literal("not_open_yet"), z.literal("open")])
});

const CurrentUserPayloadSchema = z.object({
  user: ReservationSidebarUserSchema.nullable()
});

const LoginPayloadSchema = z.object({
  error: ErrorPayloadSchema.shape.error,
  user: ReservationSidebarUserSchema.optional()
});

const PeriodsPayloadSchema = z.object({
  periods: z.array(PeriodSummarySchema)
});

export async function readApiErrorMessage(response: Response): Promise<string | null> {
  const payload = await readOptionalJson(response);
  const parsed = ErrorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.error?.message ?? null;
}

export async function readCurrentUser(response: Response): Promise<ReservationSidebarUser | null> {
  if (!response.ok) {
    return null;
  }
  const payload = await readOptionalJson(response);
  const parsed = CurrentUserPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.user;
}

export async function readLoginPayload(response: Response): Promise<LoginPayload> {
  const payload = await readOptionalJson(response);
  const parsed = LoginPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { errorMessage: null, user: null };
  }
  return {
    errorMessage: parsed.data.error?.message ?? null,
    user: parsed.data.user ?? null
  };
}

export async function readPeriodSummaries(response: Response): Promise<readonly PeriodSummary[]> {
  if (!response.ok) {
    return [];
  }
  const payload = await readOptionalJson(response);
  const parsed = PeriodsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.periods;
}

async function readOptionalJson(response: Response): Promise<unknown | null> {
  if (response.status === 204) {
    return null;
  }
  const body = await response.text();
  if (!body.trim()) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}
