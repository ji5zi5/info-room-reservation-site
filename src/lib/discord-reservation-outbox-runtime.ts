import type { DiscordApplicationConfig } from "./discord-app-config";
import { createDiscordBotClient, type DiscordBotClient, type DiscordGuildMemberClient } from "./discord-bot";
import type { DiscordInteractionDispatchResult } from "./discord-interaction-job-runner";
import { authorizeCurrentDiscordReservationActor } from "./discord-interaction-authorization";
import { sendDiscordWebhook } from "./discord-notifications";
import { loadDiscordReservationSnapshot } from "./discord-reservation-snapshot";
import { parseServerEnv } from "./env";
import { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";
import { sendReservationCreatedNotification } from "./reservation-created-notification-service";
import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";
import {
  processDiscordReservationOperation,
  type DiscordReservationOperationCommand
} from "./discord-reservation-operations";

export async function dispatchDiscordReservationOperation(input: {
  readonly command: DiscordReservationOperationCommand;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordInteractionDispatchResult> {
  const config = parseServerEnv().discordApplication;
  if (config === null) {
    return { errorCode: "discord_config_missing", errorType: "CONFIG", kind: "terminal_failure" };
  }
  const authorization = authorizeCurrentDiscordReservationActor({
    config,
    member: await createDiscordBotClient({ applicationId: config.applicationId, botToken: config.botToken })
      .getGuildMember({ guildId: config.guildId, userId: input.command.discordActorId }),
    source: input.command
  });
  switch (authorization.kind) {
    case "authorized": {
      if (
        authorization.studentNumber !== input.command.studentNumber ||
        input.command.localActorId.length === 0
      ) {
        return { terminalResult: { code: "stale_actor_mapping" }, kind: "stale" };
      }
      const result = await processDiscordReservationOperation(input);
      return result.kind === "accepted" || result.kind === "cancelled" || result.kind === "no_show"
        ? { kind: "succeeded", terminalResult: result }
        : { kind: "stale", terminalResult: result };
    }
    case "stale":
      return { kind: "stale", terminalResult: { code: authorization.code } };
    case "retryable_failure":
      return { errorCode: authorization.code, errorType: "DISCORD_MEMBER_LOOKUP", kind: "retryable_failure" };
    case "terminal_failure":
      return { errorCode: authorization.code, errorType: "DISCORD_AUTHORIZATION", kind: "terminal_failure" };
    default:
      return assertNeverAuthorization(authorization);
  }
}

export function defaultDiscordReservationOutboxDependencies(): DiscordReservationOutboxDependencies {
  const config = (): DiscordApplicationConfig | null => parseServerEnv().discordApplication;
  const bot = delegatingBotClient(config);
  return {
    bot,
    getApplicationConfig: config,
    getNotificationSettings: getPrismaNotificationSettings,
    getWebhookUrl: () => process.env.DISCORD_WEBHOOK_URL?.trim() || undefined,
    loadSnapshot: loadDiscordReservationSnapshot,
    repository: prismaDiscordReservationMessageRepository,
    sendWebhook: (input) => sendReservationCreatedNotification({
      ...input,
      sender: (payload) => sendDiscordWebhook({ payload, webhookUrl: input.webhookUrl ?? "" })
    })
  };
}

function delegatingBotClient(config: () => DiscordApplicationConfig | null): DiscordBotClient & DiscordGuildMemberClient {
  const client = (): DiscordBotClient & DiscordGuildMemberClient => {
    const current = config();
    if (current === null) {
      throw new DiscordApplicationUnavailableError();
    }
    return createDiscordBotClient({ applicationId: current.applicationId, botToken: current.botToken });
  };
  return {
    createChannelMessage: (input) => client().createChannelMessage(input),
    deleteChannelMessage: (input) => client().deleteChannelMessage(input),
    editChannelMessage: (input) => client().editChannelMessage(input),
    editOriginalEphemeralResponse: (input) => client().editOriginalEphemeralResponse(input),
    getGuildMember: (input) => client().getGuildMember(input)
  };
}

function assertNeverAuthorization(value: never): never {
  throw new DiscordReservationAuthorizationVariantError(String(value));
}

class DiscordReservationAuthorizationVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord reservation authorization variant: ${value}`);
    this.name = "DiscordReservationAuthorizationVariantError";
  }
}

class DiscordApplicationUnavailableError extends Error {
  public constructor() {
    super("Discord application configuration is unavailable");
    this.name = "DiscordApplicationUnavailableError";
  }
}
