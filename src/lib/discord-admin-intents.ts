import { z } from "zod";

import type { StudyPeriod } from "./study-periods";

export const discordAdminReasonSchema = z.string().trim().min(1).max(200);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const periodSchema = z.union([z.literal("EIGHTH"), z.literal("FIRST")]);
const scopeSchema = z.union([z.literal("ALL"), z.literal("DATE")]);
const profileSchema = z.union([z.literal("LOW"), z.literal("NORMAL"), z.literal("HIGH")]);

const directIntentSchemas = [
  z.object({ date: dateSchema, kind: z.literal("status") }),
  z.object({ date: dateSchema, kind: z.literal("roster"), studyPeriod: periodSchema.nullable() }),
  z.object({ date: dateSchema, kind: z.literal("settings_get") }),
  z.object({ kind: z.literal("student_lookup"), query: z.string().trim().min(1).max(40) }),
  z.object({ kind: z.literal("notification_status") }),
  z.object({ kind: z.literal("operations_status") }),
  z.object({ kind: z.literal("operations_backlog") }),
  z.object({ kind: z.literal("operations_sync") }),
  z.object({ date: dateSchema, force: z.boolean(), kind: z.literal("closed_list_send"), studyPeriod: periodSchema }),
  z.object({
    date: dateSchema,
    kind: z.literal("reservation_create"),
    reservationReason: z.string().trim().min(1).max(80),
    studentNumber: z.string().trim().regex(/^\d{5}$/u),
    studyPeriod: periodSchema
  })
] as const;

const reasonDraftSchemas = [
  z.object({ date: dateSchema, kind: z.literal("reservation_cancel"), studentNumber: z.string().regex(/^\d{5}$/u), studyPeriod: periodSchema }),
  z.object({ date: dateSchema, kind: z.literal("reservation_bulk_cancel"), studyPeriod: periodSchema }),
  z.object({ days: z.number().int().min(1).max(365), kind: z.literal("student_restrict"), studentNumber: z.string().regex(/^\d{5}$/u) }),
  z.object({ kind: z.literal("student_ban"), studentNumber: z.string().regex(/^\d{5}$/u) }),
  z.object({ kind: z.literal("student_blacklist"), profile: profileSchema, studentNumber: z.string().regex(/^\d{5}$/u) }),
  z.object({ kind: z.literal("student_release"), releaseType: z.union([z.literal("ALL"), z.literal("RESTRICTION"), z.literal("BAN"), z.literal("BLACKLIST")]), studentNumber: z.string().regex(/^\d{5}$/u) }),
  z.object({ closeTime: z.string().regex(/^\d{2}:\d{2}$/u), date: dateSchema.nullable(), kind: z.literal("setting_time"), openTime: z.string().regex(/^\d{2}:\d{2}$/u), scope: scopeSchema, studyPeriod: periodSchema }),
  z.object({ capacity: z.number().int().min(1).max(200), date: dateSchema.nullable(), kind: z.literal("setting_capacity"), scope: scopeSchema, studyPeriod: periodSchema }),
  z.object({ date: dateSchema.nullable(), enabled: z.boolean(), kind: z.literal("setting_enabled"), scope: scopeSchema, studyPeriod: periodSchema }),
  z.object({ enabled: z.boolean(), kind: z.literal("notification_reservation_created") }),
  z.object({ enabled: z.boolean(), kind: z.literal("notification_closed") })
] as const;

const directIntentSchema = z.discriminatedUnion("kind", directIntentSchemas);
const reasonDraftSchema = z.discriminatedUnion("kind", reasonDraftSchemas);
const storedDraftSchema = z.union([directIntentSchema, reasonDraftSchema]);

export type DiscordAdminDirectIntent = z.infer<typeof directIntentSchema>;
export type DiscordAdminReasonDraft = z.infer<typeof reasonDraftSchema>;
export type DiscordAdminDraftIntent = DiscordAdminDirectIntent | DiscordAdminReasonDraft;
type WithReason<T> = T extends DiscordAdminReasonDraft ? T & { readonly reason: string } : never;
export type DiscordAdminIntent = DiscordAdminDirectIntent | WithReason<DiscordAdminReasonDraft>;
export type DiscordAdminReadIntent = Extract<DiscordAdminDirectIntent, {
  readonly kind: "notification_status" | "operations_backlog" | "operations_status" | "roster" | "settings_get" | "status" | "student_lookup";
}>;

export function parseDiscordAdminDraftIntent(value: unknown): DiscordAdminDraftIntent | null {
  const parsed = storedDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function completeDiscordAdminIntent(
  draft: DiscordAdminDraftIntent,
  reason: string | null
): DiscordAdminIntent | null {
  if (isDiscordAdminReasonDraft(draft)) {
    const parsedReason = discordAdminReasonSchema.safeParse(reason);
    return parsedReason.success ? { ...draft, reason: parsedReason.data } : null;
  }
  return reason === null ? draft : null;
}

export function isDiscordAdminReasonDraft(intent: DiscordAdminDraftIntent): intent is DiscordAdminReasonDraft {
  switch (intent.kind) {
    case "reservation_cancel":
    case "reservation_bulk_cancel":
    case "student_restrict":
    case "student_ban":
    case "student_blacklist":
    case "student_release":
    case "setting_time":
    case "setting_capacity":
    case "setting_enabled":
    case "notification_reservation_created":
    case "notification_closed":
      return true;
    case "status":
    case "roster":
    case "settings_get":
    case "student_lookup":
    case "notification_status":
    case "operations_status":
    case "operations_backlog":
    case "operations_sync":
    case "closed_list_send":
    case "reservation_create":
      return false;
    default:
      return assertNever(intent);
  }
}

export function isDiscordAdminReadIntent(intent: DiscordAdminDraftIntent): intent is DiscordAdminReadIntent {
  switch (intent.kind) {
    case "status":
    case "roster":
    case "settings_get":
    case "student_lookup":
    case "notification_status":
    case "operations_status":
    case "operations_backlog":
      return true;
    case "operations_sync":
    case "closed_list_send":
    case "reservation_create":
    case "reservation_cancel":
    case "reservation_bulk_cancel":
    case "student_restrict":
    case "student_ban":
    case "student_blacklist":
    case "student_release":
    case "setting_time":
    case "setting_capacity":
    case "setting_enabled":
    case "notification_reservation_created":
    case "notification_closed":
      return false;
    default:
      return assertNever(intent);
  }
}

export type DiscordAdminSettingScope = "ALL" | "DATE";
export type DiscordAdminReleaseType = "ALL" | "RESTRICTION" | "BAN" | "BLACKLIST";
export type DiscordAdminBlacklistProfile = "LOW" | "NORMAL" | "HIGH";
export type DiscordAdminStudyPeriod = StudyPeriod;

function assertNever(value: never): never {
  throw new DiscordAdminIntentVariantError(JSON.stringify(value));
}

class DiscordAdminIntentVariantError extends Error {
  public override readonly name = "DiscordAdminIntentVariantError";

  public constructor(value: string) {
    super(`Unhandled Discord administrator intent: ${value}`);
  }
}
