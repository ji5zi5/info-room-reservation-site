import type { DiscordApplicationConfig } from "./discord-app-config";
import { createDiscordBotClient, type DiscordBotClient } from "./discord-bot";
import { sendDiscordWebhook } from "./discord-notifications";
import { loadDiscordReservationSnapshot } from "./discord-reservation-snapshot";
import { parseServerEnv } from "./env";
import { prismaDiscordReservationMessageRepository } from "./prisma-discord-reservation-message-repository";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";
import { sendReservationCreatedNotification } from "./reservation-created-notification-service";
import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";

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

function delegatingBotClient(config: () => DiscordApplicationConfig | null): DiscordBotClient {
  const client = (): DiscordBotClient => {
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
    editOriginalEphemeralResponse: (input) => client().editOriginalEphemeralResponse(input)
  };
}

class DiscordApplicationUnavailableError extends Error {
  public constructor() {
    super("Discord application configuration is unavailable");
    this.name = "DiscordApplicationUnavailableError";
  }
}
