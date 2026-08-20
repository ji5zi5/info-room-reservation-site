import { z } from "zod";

import { toKstDate } from "./date";
import type { DiscordAdminDraftIntent } from "./discord-admin-intents";

const rootSchema = z.object({
  name: z.literal("정보실"),
  options: z.array(z.unknown()).length(1)
}).passthrough();
const optionSchema = z.object({
  name: z.string().min(1),
  options: z.array(z.unknown()).optional(),
  type: z.number().int(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
}).passthrough();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/u);
const studentNumberSchema = z.string().regex(/^\d{5}$/u);

type ParsedOption = {
  readonly name: string;
  readonly options: readonly ParsedOption[];
  readonly type: number;
  readonly value?: string | number | boolean;
};

type CommandSelection = {
  readonly arguments: readonly ParsedOption[];
  readonly path: string;
};

export function parseDiscordAdminCommandData(input: unknown, now: Date): DiscordAdminDraftIntent | null {
  const root = rootSchema.safeParse(input);
  if (!root.success) return null;
  const option = parseOption(root.data.options[0]);
  const selection = option === null ? null : selectCommand(option);
  if (selection === null) return null;
  const date = optionalDate(selection.arguments, "날짜") ?? toKstDate(now);

  switch (selection.path) {
    case "현황": return { date, kind: "status" };
    case "명단": return { date, kind: "roster", studyPeriod: optionalPeriod(selection.arguments, "시간대") };
    case "예약/추가": {
      const studentNumber = stringValue(selection.arguments, "학번", studentNumberSchema);
      const studyPeriod = periodValue(selection.arguments, "시간대");
      const reservationReason = stringValue(selection.arguments, "신청사유", z.string().trim().min(1).max(80));
      return studentNumber === null || studyPeriod === null || reservationReason === null
        ? null
        : { date, kind: "reservation_create", reservationReason, studentNumber, studyPeriod };
    }
    case "예약/취소": {
      const studentNumber = stringValue(selection.arguments, "학번", studentNumberSchema);
      const studyPeriod = periodValue(selection.arguments, "시간대");
      return studentNumber === null || studyPeriod === null ? null : { date, kind: "reservation_cancel", studentNumber, studyPeriod };
    }
    case "예약/일괄취소": {
      const studyPeriod = periodValue(selection.arguments, "시간대");
      return studyPeriod === null ? null : { date, kind: "reservation_bulk_cancel", studyPeriod };
    }
    case "학생/조회": {
      const query = stringValue(selection.arguments, "검색어", z.string().trim().min(1).max(40));
      return query === null ? null : { kind: "student_lookup", query };
    }
    case "학생/제한": {
      const studentNumber = stringValue(selection.arguments, "학번", studentNumberSchema);
      const days = integerValue(selection.arguments, "일수", 1, 365);
      return studentNumber === null || days === null ? null : { days, kind: "student_restrict", studentNumber };
    }
    case "학생/밴": return studentOnly(selection.arguments, "student_ban");
    case "학생/블랙": {
      const studentNumber = stringValue(selection.arguments, "학번", studentNumberSchema);
      const profile = stringValue(selection.arguments, "강도", z.union([z.literal("LOW"), z.literal("NORMAL"), z.literal("HIGH")]));
      return studentNumber === null || profile === null ? null : { kind: "student_blacklist", profile, studentNumber };
    }
    case "학생/해제": {
      const studentNumber = stringValue(selection.arguments, "학번", studentNumberSchema);
      const releaseType = stringValue(selection.arguments, "종류", z.union([z.literal("ALL"), z.literal("RESTRICTION"), z.literal("BAN"), z.literal("BLACKLIST")]));
      return studentNumber === null || releaseType === null ? null : { kind: "student_release", releaseType, studentNumber };
    }
    case "설정/조회": return { date, kind: "settings_get" };
    case "설정/시간": return parseTimeSetting(selection.arguments);
    case "설정/정원": return parseCapacitySetting(selection.arguments);
    case "설정/활성": return parseEnabledSetting(selection.arguments);
    case "알림/상태": return { kind: "notification_status" };
    case "알림/신청": return notificationToggle(selection.arguments, "notification_reservation_created");
    case "알림/마감": return notificationToggle(selection.arguments, "notification_closed");
    case "알림/마감전송": {
      const studyPeriod = periodValue(selection.arguments, "시간대");
      const force = booleanValue(selection.arguments, "강제") ?? false;
      return studyPeriod === null ? null : { date, force, kind: "closed_list_send", studyPeriod };
    }
    case "운영/상태": return { kind: "operations_status" };
    case "운영/미처리": return { kind: "operations_backlog" };
    case "운영/동기화": return { kind: "operations_sync" };
    default: return null;
  }
}

function parseTimeSetting(options: readonly ParsedOption[]): DiscordAdminDraftIntent | null {
  const common = settingTarget(options);
  const openTime = stringValue(options, "시작", timeSchema);
  const closeTime = stringValue(options, "마감", timeSchema);
  return common === null || openTime === null || closeTime === null
    ? null
    : { ...common, closeTime, kind: "setting_time", openTime };
}

function parseCapacitySetting(options: readonly ParsedOption[]): DiscordAdminDraftIntent | null {
  const common = settingTarget(options);
  const capacity = integerValue(options, "정원", 1, 200);
  return common === null || capacity === null ? null : { ...common, capacity, kind: "setting_capacity" };
}

function parseEnabledSetting(options: readonly ParsedOption[]): DiscordAdminDraftIntent | null {
  const common = settingTarget(options);
  const enabled = booleanValue(options, "사용");
  return common === null || enabled === null ? null : { ...common, enabled, kind: "setting_enabled" };
}

function settingTarget(options: readonly ParsedOption[]) {
  const scope = stringValue(options, "범위", z.union([z.literal("ALL"), z.literal("DATE")]));
  const studyPeriod = periodValue(options, "시간대");
  const date = optionalDate(options, "날짜");
  if (scope === null || studyPeriod === null || (scope === "DATE" && date === null)) return null;
  return { date: scope === "ALL" ? null : date, scope, studyPeriod } as const;
}

function studentOnly(options: readonly ParsedOption[], kind: "student_ban"): DiscordAdminDraftIntent | null {
  const studentNumber = stringValue(options, "학번", studentNumberSchema);
  return studentNumber === null ? null : { kind, studentNumber };
}

function notificationToggle(options: readonly ParsedOption[], kind: "notification_closed" | "notification_reservation_created"): DiscordAdminDraftIntent | null {
  const enabled = booleanValue(options, "사용");
  return enabled === null ? null : { enabled, kind };
}

function selectCommand(option: ParsedOption): CommandSelection | null {
  if (option.type === 1) return { arguments: option.options, path: option.name };
  if (option.type !== 2 || option.options.length !== 1) return null;
  const child = option.options[0];
  return child?.type === 1 ? { arguments: child.options, path: `${option.name}/${child.name}` } : null;
}

function parseOption(input: unknown): ParsedOption | null {
  const parsed = optionSchema.safeParse(input);
  if (!parsed.success) return null;
  const children = (parsed.data.options ?? []).map(parseOption);
  if (children.some((child) => child === null)) return null;
  return {
    name: parsed.data.name,
    options: children.filter((child): child is ParsedOption => child !== null),
    type: parsed.data.type,
    ...(parsed.data.value === undefined ? {} : { value: parsed.data.value })
  };
}

function stringValue<T extends string>(options: readonly ParsedOption[], name: string, schema: z.ZodType<T>): T | null {
  const value = options.find((option) => option.name === name && option.type === 3)?.value;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function optionalDate(options: readonly ParsedOption[], name: string): string | null {
  const option = options.find((candidate) => candidate.name === name);
  return option === undefined ? null : stringValue(options, name, dateSchema);
}

function periodValue(options: readonly ParsedOption[], name: string) {
  return stringValue(options, name, z.union([z.literal("EIGHTH"), z.literal("FIRST")]));
}

function optionalPeriod(options: readonly ParsedOption[], name: string) {
  return options.some((option) => option.name === name) ? periodValue(options, name) : null;
}

function integerValue(options: readonly ParsedOption[], name: string, minimum: number, maximum: number): number | null {
  const value = options.find((option) => option.name === name && option.type === 4)?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function booleanValue(options: readonly ParsedOption[], name: string): boolean | null {
  const value = options.find((option) => option.name === name && option.type === 5)?.value;
  return typeof value === "boolean" ? value : null;
}
