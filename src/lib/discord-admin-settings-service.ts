import { prisma } from "./db";
import { toKstDate } from "./date";
import { withDatabaseMutation } from "./db-context";
import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminIntent } from "./discord-admin-intents";
import {
  GLOBAL_PERIOD_SETTINGS_DATE,
  periodSettingReadDates,
  resolveEffectivePeriodSetting,
  type PeriodSettingDefaults
} from "./period-setting-values";

type SettingIntent = Extract<DiscordAdminIntent, {
  readonly kind: "setting_capacity" | "setting_enabled" | "setting_time";
}>;

export type DiscordAdminSettingResult = {
  readonly after: PeriodSettingDefaults;
  readonly before: PeriodSettingDefaults;
  readonly kind: "updated";
  readonly scope: "ALL" | "DATE";
};

export async function updateDiscordAdminPeriodSetting(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: SettingIntent;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordAdminSettingResult> {
  const targetDate = input.intent.scope === "ALL" ? GLOBAL_PERIOD_SETTINGS_DATE : input.intent.date;
  if (targetDate === null) throw new DiscordAdminSettingTargetError();
  return withDatabaseMutation({
    actor: input.actor,
    client: prisma,
    lockKeys: [`period-settings:${input.intent.studyPeriod}`],
    operation: async (transaction) => {
      const rows = await transaction.periodSetting.findMany({
        where: { date: { in: [...periodSettingReadDates(targetDate)] }, studyPeriod: input.intent.studyPeriod }
      });
      const before = resolveEffectivePeriodSetting(targetDate, input.intent.studyPeriod, rows);
      const after = applySettingIntent(before, input.intent);
      const data = {
        capacity: after.capacity,
        closeTime: after.closeTime,
        enabled: after.enabled,
        openTime: after.openTime
      };
      if (input.intent.scope === "ALL") {
        await transaction.periodSetting.updateMany({
          data: changedField(input.intent),
          where: { date: { gt: toKstDate(input.now) }, studyPeriod: input.intent.studyPeriod }
        });
      }
      await transaction.periodSetting.upsert({
        create: { ...data, date: targetDate, studyPeriod: input.intent.studyPeriod },
        update: data,
        where: { date_studyPeriod: { date: targetDate, studyPeriod: input.intent.studyPeriod } }
      });
      const action = await transaction.adminAction.create({ data: {
        action: "PERIOD_SETTINGS_PATCH",
        actorId: input.actor.id,
        after: JSON.stringify(after),
        before: JSON.stringify(before),
        ipHash: input.ipHash,
        reason: input.intent.reason
      } });
      await transaction.auditLog.create({ data: {
        action: "PERIOD_SETTINGS_PATCH",
        actorId: input.actor.id,
        detail: JSON.stringify({ actionId: action.id, date: targetDate, reason: input.intent.reason, scope: input.intent.scope, studyPeriod: input.intent.studyPeriod })
      } });
      return { after, before, kind: "updated", scope: input.intent.scope };
    }
  });
}

function applySettingIntent(before: PeriodSettingDefaults, intent: SettingIntent): PeriodSettingDefaults {
  switch (intent.kind) {
    case "setting_time": return { ...before, closeTime: intent.closeTime, openTime: intent.openTime };
    case "setting_capacity": return { ...before, capacity: intent.capacity };
    case "setting_enabled": return { ...before, enabled: intent.enabled };
    default: return assertNever(intent);
  }
}

function changedField(intent: SettingIntent) {
  switch (intent.kind) {
    case "setting_time": return { closeTime: intent.closeTime, openTime: intent.openTime };
    case "setting_capacity": return { capacity: intent.capacity };
    case "setting_enabled": return { enabled: intent.enabled };
    default: return assertNever(intent);
  }
}

function assertNever(value: never): never {
  throw new DiscordAdminSettingVariantError(JSON.stringify(value));
}

class DiscordAdminSettingTargetError extends Error {
  public override readonly name = "DiscordAdminSettingTargetError";
}

class DiscordAdminSettingVariantError extends Error {
  public override readonly name = "DiscordAdminSettingVariantError";
}
