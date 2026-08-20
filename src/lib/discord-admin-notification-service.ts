import { createClosedPeriodNotificationService } from "./closed-period-notification-service";
import { prisma } from "./db";
import { withDatabaseContext } from "./db-context";
import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminIntent } from "./discord-admin-intents";
import { sendDiscordWebhook } from "./discord-notifications";
import { GLOBAL_NOTIFICATION_SETTINGS_ID, defaultNotificationSettings, normalizeNotificationSettings } from "./notification-settings";
import { prismaClosedPeriodNotificationRepository } from "./prisma-notification-repository";

type NotificationMutationIntent = Extract<DiscordAdminIntent, {
  readonly kind: "closed_list_send" | "notification_closed" | "notification_reservation_created";
}>;

export type DiscordAdminNotificationResult =
  | {
      readonly after: { readonly closedEnabled: boolean; readonly reservationEnabled: boolean };
      readonly before: { readonly closedEnabled: boolean; readonly reservationEnabled: boolean };
      readonly kind: "settings_updated";
    }
  | { readonly kind: "sent"; readonly messageCount: number }
  | { readonly code: string; readonly kind: "noop" };

export async function executeDiscordAdminNotificationMutation(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: NotificationMutationIntent;
  readonly ipHash: string;
  readonly now: Date;
  readonly webhookUrl: string | undefined;
}): Promise<DiscordAdminNotificationResult> {
  switch (input.intent.kind) {
    case "notification_closed":
    case "notification_reservation_created":
      return updateNotificationSetting({ actor: input.actor, intent: input.intent, ipHash: input.ipHash });
    case "closed_list_send":
      return sendClosedList({ actor: input.actor, intent: input.intent, ipHash: input.ipHash, now: input.now, webhookUrl: input.webhookUrl });
    default:
      return assertNever(input.intent);
  }
}

async function updateNotificationSetting(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: Extract<NotificationMutationIntent, { readonly kind: "notification_closed" | "notification_reservation_created" }>;
  readonly ipHash: string;
}): Promise<DiscordAdminNotificationResult> {
  return withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: async (transaction) => {
      const defaults = defaultNotificationSettings();
      const before = normalizeNotificationSettings(await transaction.notificationSetting.findUnique({ where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID } }));
      const patch = input.intent.kind === "notification_closed"
        ? { closedPeriodNotificationsEnabled: input.intent.enabled }
        : { reservationCreatedNotificationsEnabled: input.intent.enabled };
      const row = await transaction.notificationSetting.upsert({
        create: { ...defaults, ...patch, id: GLOBAL_NOTIFICATION_SETTINGS_ID },
        update: patch,
        where: { id: GLOBAL_NOTIFICATION_SETTINGS_ID }
      });
      const after = normalizeNotificationSettings(row);
      const action = await transaction.adminAction.create({ data: {
        action: "NOTIFICATION_SETTINGS_PATCH",
        actorId: input.actor.id,
        after: JSON.stringify(after),
        before: JSON.stringify(before),
        ipHash: input.ipHash,
        reason: input.intent.reason
      } });
      await transaction.auditLog.create({ data: {
        action: "NOTIFICATION_SETTINGS_PATCH",
        actorId: input.actor.id,
        detail: JSON.stringify({ actionId: action.id, reason: input.intent.reason })
      } });
      return {
        after: {
          closedEnabled: after.closedPeriodNotificationsEnabled,
          reservationEnabled: after.reservationCreatedNotificationsEnabled
        },
        before: {
          closedEnabled: before.closedPeriodNotificationsEnabled,
          reservationEnabled: before.reservationCreatedNotificationsEnabled
        },
        kind: "settings_updated"
      };
    }
  });
}

async function sendClosedList(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: Extract<NotificationMutationIntent, { readonly kind: "closed_list_send" }>;
  readonly ipHash: string;
  readonly now: Date;
  readonly webhookUrl: string | undefined;
}): Promise<DiscordAdminNotificationResult> {
  if (input.webhookUrl === undefined) return { code: "discord_webhook_missing", kind: "noop" };
  const service = createClosedPeriodNotificationService({
    now: input.now,
    repository: prismaClosedPeriodNotificationRepository,
    sender: (payload) => sendDiscordWebhook({ payload, webhookUrl: input.webhookUrl ?? "" })
  });
  const result = await service.sendClosedPeriod({
    date: input.intent.date,
    force: input.intent.force,
    manual: true,
    studyPeriod: input.intent.studyPeriod
  });
  if (result.kind !== "sent") return { code: result.kind === "skipped" ? result.reason : result.kind, kind: "noop" };
  const messageCount = result.delivery.messageIds?.length ?? 0;
  await withDatabaseContext({
    actor: input.actor,
    client: prisma,
    operation: async (transaction) => {
      const action = await transaction.adminAction.create({ data: {
        action: "CLOSED_LIST_NOTIFICATION_SEND",
        actorId: input.actor.id,
        after: JSON.stringify({ date: input.intent.date, messageCount, studyPeriod: input.intent.studyPeriod }),
        ipHash: input.ipHash,
        reason: "Discord 관리자 명령"
      } });
      await transaction.auditLog.create({ data: {
        action: "CLOSED_LIST_NOTIFICATION_SEND",
        actorId: input.actor.id,
        detail: JSON.stringify({ actionId: action.id, date: input.intent.date, force: input.intent.force, studyPeriod: input.intent.studyPeriod })
      } });
    }
  });
  return { kind: "sent", messageCount };
}

function assertNever(value: never): never {
  throw new DiscordAdminNotificationVariantError(JSON.stringify(value));
}

class DiscordAdminNotificationVariantError extends Error {
  public override readonly name = "DiscordAdminNotificationVariantError";
}
