import { z } from "zod";

import type { PeriodSummary } from "@/components/reservation-period-card";
import type { StudentProfilePayload } from "@/lib/student-profile";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type LoginPayload = {
  readonly errorMessage: string | null;
  readonly user: ReservationSidebarUser | null;
};

export type StudentProfilePayloadReadResult =
  | { readonly kind: "loaded"; readonly profile: StudentProfilePayload }
  | { readonly kind: "error"; readonly message: string };

type JsonBodyReadResult =
  | { readonly kind: "empty" }
  | { readonly kind: "loaded"; readonly value: unknown }
  | { readonly kind: "malformed" };

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
  restrictionReason: z.string().nullable().default(null),
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

const BookingStatusSchema = z.enum(["ACTIVE", "RESTRICTED", "BANNED", "SHADOW_BANNED"]);

const StudentProfileReservationSchema = z.object({
  createdAt: z.string(),
  date: z.string(),
  status: z.enum(["CONFIRMED", "CANCELLED", "NO_SHOW"]),
  studyPeriod: z.enum(["EIGHTH", "FIRST"]),
  updatedAt: z.string()
});

const StudentProfileSanctionSchema = z.object({
  createdAt: z.string(),
  endsAt: z.string().nullable(),
  reason: z.string(),
  revokedAt: z.string().nullable(),
  startsAt: z.string(),
  status: z.enum(["ACTIVE", "REVOKED"]),
  type: z.string()
});

const StudentProfilePayloadSchema = z.object({
  currentReservations: z.array(StudentProfileReservationSchema),
  effectiveStatus: BookingStatusSchema,
  recentReservations: z.array(StudentProfileReservationSchema),
  recentSanctions: z.array(StudentProfileSanctionSchema),
  reservationSummary: z.object({ cancelledCount: z.number(), confirmedCount: z.number(), noShowCount: z.number() }),
  sanctionSummary: z.object({ activeCount: z.number(), permanentCount: z.number(), revokedCount: z.number(), totalCount: z.number() }),
  statusMessage: z.enum(["예약 가능", "예약 제한", "영구 제한"]),
  user: z.object({
    bookingStatus: BookingStatusSchema,
    generation: z.number(),
    name: z.string(),
    restrictionReason: z.string().nullable(),
    restrictedUntil: z.string().nullable(),
    role: z.string(),
    studentNumber: z.string()
  })
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

export async function readStudentProfilePayload(response: Response): Promise<StudentProfilePayloadReadResult> {
  if (!response.ok) {
    const message = await readApiErrorMessage(response);
    return { kind: "error", message: message ?? "프로필을 불러오지 못했습니다." };
  }

  const payload = await readJsonBody(response);
  switch (payload.kind) {
    case "empty":
      return { kind: "error", message: "프로필 응답이 비어 있습니다." };
    case "loaded": {
      const parsed = StudentProfilePayloadSchema.safeParse(payload.value);
      if (!parsed.success) {
        return { kind: "error", message: "프로필 응답 형식이 올바르지 않습니다." };
      }
      return { kind: "loaded", profile: parsed.data };
    }
    case "malformed":
      return { kind: "error", message: "프로필 응답을 읽을 수 없습니다." };
    default:
      return assertNever(payload);
  }
}

async function readOptionalJson(response: Response): Promise<unknown | null> {
  const payload = await readJsonBody(response);
  switch (payload.kind) {
    case "empty":
    case "malformed":
      return null;
    case "loaded":
      return payload.value;
    default:
      return assertNever(payload);
  }
}

async function readJsonBody(response: Response): Promise<JsonBodyReadResult> {
  if (response.status === 204) {
    return { kind: "empty" };
  }
  const body = await response.text();
  if (!body.trim()) {
    return { kind: "empty" };
  }
  try {
    const value: unknown = JSON.parse(body);
    return { kind: "loaded", value };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: "malformed" };
    }
    throw error;
  }
}

function assertNever(value: never): never {
  throw new UnreachableClientApiResponseVariantError(String(value));
}

class UnreachableClientApiResponseVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled client API response variant: ${value}`);
    this.name = "UnreachableClientApiResponseVariantError";
  }
}
