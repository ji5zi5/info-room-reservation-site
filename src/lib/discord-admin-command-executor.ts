import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordAdminCommandClaim, DiscordAdminCommandDispatchResult } from "./discord-admin-command-runner";
import { buildDiscordAdminCommandDigest } from "./discord-admin-command-digest";
import {
  discordAdminFailureResult,
  discordAdminSuccessResult,
  type DiscordAdminCommandResult
} from "./discord-admin-command-results";
import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import {
  completeDiscordAdminIntent,
  isDiscordAdminReadIntent,
  parseDiscordAdminDraftIntent,
  type DiscordAdminDirectIntent,
  type DiscordAdminIntent
} from "./discord-admin-intents";
import { executeDiscordAdminNotificationMutation } from "./discord-admin-notification-service";
import { executeDiscordAdminReadIntent } from "./discord-admin-query-service";
import { executeDiscordAdminReservationIntent } from "./discord-admin-reservation-service";
import {
  formatDiscordAdminNotificationResult,
  formatDiscordAdminReservationResult,
  formatDiscordAdminSettingResult,
  formatDiscordAdminUserResult
} from "./discord-admin-result-formatters";
import { formatDiscordAdminReadResult } from "./discord-admin-read-result-formatter";
import { updateDiscordAdminPeriodSetting } from "./discord-admin-settings-service";
import { executeDiscordAdminUserMutation } from "./discord-admin-user-service";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

export async function dispatchDiscordAdminCommand(input: {
  readonly claim: DiscordAdminCommandClaim;
  readonly config: DiscordApplicationConfig;
  readonly now: Date;
}): Promise<DiscordAdminCommandDispatchResult> {
  const draft = parsePersistedDraft(input.claim.draftIntent);
  const intent = draft === null ? null : completeDiscordAdminIntent(draft, input.claim.reason);
  if (intent === null || !isClaimAuthentic(input.claim, input.config)) {
    return { errorCode: "persisted_command_invalid", errorType: "INTEGRITY", kind: "terminal_failure" };
  }
  const actor = await loadClaimActor(input.claim, input.config);
  if (actor === null) {
    return {
      kind: "stale",
      result: discordAdminFailureResult({ description: "관리자 권한 또는 연결 정보가 변경되어 실행하지 않았습니다.", title: "권한 확인 실패" })
    };
  }
  const result = await executeDiscordAdminIntent({
    actor,
    intent,
    ipHash: input.claim.ipHash,
    now: input.now,
    secret: input.config.botToken
  });
  return { kind: result.outcome === "stale" ? "stale" : "succeeded", result };
}

export async function executeDiscordAdminReadCommand(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: DiscordAdminDirectIntent;
  readonly now: Date;
  readonly secret: string;
}): Promise<DiscordAdminCommandResult> {
  if (!isDiscordAdminReadIntent(input.intent)) {
    return discordAdminFailureResult({ description: "조회 명령 형식이 올바르지 않습니다.", title: "명령 오류" });
  }
  const result = await executeDiscordAdminReadIntent({ actor: input.actor, intent: input.intent, now: input.now });
  return formatDiscordAdminReadResult({ intent: input.intent, result, secret: input.secret });
}

async function executeDiscordAdminIntent(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: DiscordAdminIntent;
  readonly ipHash: string;
  readonly now: Date;
  readonly secret: string;
}): Promise<DiscordAdminCommandResult> {
  switch (input.intent.kind) {
    case "status":
    case "roster":
    case "settings_get":
    case "student_lookup":
    case "notification_status":
    case "operations_status":
    case "operations_backlog": {
      const result = await executeDiscordAdminReadIntent({ actor: input.actor, intent: input.intent, now: input.now });
      return formatDiscordAdminReadResult({ intent: input.intent, result, secret: input.secret });
    }
    case "operations_sync":
      return discordAdminSuccessResult({ description: "운영판 동기화를 요청했습니다.", title: "동기화 요청 완료" });
    case "reservation_create":
    case "reservation_cancel":
    case "reservation_bulk_cancel": {
      const result = await executeDiscordAdminReservationIntent({ actor: input.actor, intent: input.intent, ipHash: input.ipHash, now: input.now });
      return formatDiscordAdminReservationResult({ actor: input.actor, intent: input.intent, result });
    }
    case "student_restrict":
    case "student_ban":
    case "student_blacklist":
    case "student_release": {
      const result = await executeDiscordAdminUserMutation({ actor: input.actor, intent: input.intent, ipHash: input.ipHash, now: input.now });
      return formatDiscordAdminUserResult({ actor: input.actor, intent: input.intent, result });
    }
    case "setting_time":
    case "setting_capacity":
    case "setting_enabled": {
      const result = await updateDiscordAdminPeriodSetting({
        actor: input.actor,
        intent: input.intent,
        ipHash: input.ipHash,
        now: input.now
      });
      return formatDiscordAdminSettingResult({ actor: input.actor, intent: input.intent, result });
    }
    case "notification_reservation_created":
    case "notification_closed":
    case "closed_list_send": {
      const result = await executeDiscordAdminNotificationMutation({
        actor: input.actor,
        intent: input.intent,
        ipHash: input.ipHash,
        now: input.now,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL
      });
      return formatDiscordAdminNotificationResult({ actor: input.actor, intent: input.intent, result });
    }
    default:
      return assertNever(input.intent);
  }
}

function parsePersistedDraft(value: string) {
  try {
    return parseDiscordAdminDraftIntent(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isClaimAuthentic(claim: DiscordAdminCommandClaim, config: DiscordApplicationConfig): boolean {
  if (
    claim.sourceApplicationId !== config.applicationId || claim.sourceGuildId !== config.guildId ||
    claim.sourceChannelId !== config.channelId
  ) return false;
  return buildDiscordAdminCommandDigest({
    discordActorId: claim.discordActorId,
    draftIntent: claim.draftIntent,
    executionInteractionId: claim.executionInteractionId,
    ipHash: claim.ipHash,
    localActorId: claim.localActorId,
    reason: claim.reason,
    sourceApplicationId: claim.sourceApplicationId,
    sourceChannelId: claim.sourceChannelId,
    sourceGuildId: claim.sourceGuildId,
    sourceInteractionId: claim.sourceInteractionId
  }) === claim.commandDigest;
}

async function loadClaimActor(
  claim: DiscordAdminCommandClaim,
  config: DiscordApplicationConfig
): Promise<DiscordAuthorizedAdmin | null> {
  const binding = config.adminUserBindings.find((candidate) => candidate.discordUserId === claim.discordActorId);
  if (binding === undefined) return null;
  const actor = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: (transaction) => transaction.user.findUnique({
      select: { id: true, name: true, role: true, studentNumber: true },
      where: { id: claim.localActorId }
    })
  });
  return actor?.role === "ADMIN" && actor.studentNumber === binding.studentNumber
    ? { ...actor, discordUserId: claim.discordActorId, role: "ADMIN" }
    : null;
}

function assertNever(value: never): never {
  throw new DiscordAdminCommandExecutionVariantError(JSON.stringify(value));
}

class DiscordAdminCommandExecutionVariantError extends Error {
  public override readonly name = "DiscordAdminCommandExecutionVariantError";
}
