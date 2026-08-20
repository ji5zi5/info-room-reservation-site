import type { DiscordApplicationConfig } from "./discord-app-config";
import { createDiscordBotClient, type DiscordBotClient } from "./discord-bot";
import { pinDiscordChannelMessage, type DiscordMessagePinResult } from "./discord-message-pin";
import {
  buildDiscordOperationsBoardPayload,
  discordOperationsBoardStateDigest,
  type DiscordOperationsBoardSnapshot
} from "./discord-operations-board-contracts";
import { loadDiscordOperationsBoardSnapshot } from "./discord-operations-board-snapshot";
import {
  claimDiscordOperationsBoardSync,
  completeDiscordOperationsBoardSync,
  completeUnchangedDiscordOperationsBoardSync,
  failDiscordOperationsBoardSync,
  type DiscordOperationsBoardClaim
} from "./prisma-discord-operations-board";
import { toKstDate } from "./date";

type BoardBotClient = Pick<DiscordBotClient, "createChannelMessage" | "deleteChannelMessage" | "editChannelMessage">;

type DiscordOperationsBoardDependencies = {
  readonly claim: typeof claimDiscordOperationsBoardSync;
  readonly complete: typeof completeDiscordOperationsBoardSync;
  readonly completeUnchanged: typeof completeUnchangedDiscordOperationsBoardSync;
  readonly fail: typeof failDiscordOperationsBoardSync;
  readonly loadSnapshot: (input: { readonly date: string; readonly now: Date }) => Promise<DiscordOperationsBoardSnapshot>;
  readonly pin: (input: { readonly botToken: string; readonly channelId: string; readonly messageId: string }) => Promise<DiscordMessagePinResult>;
};

export type DiscordOperationsBoardSyncResult =
  | { readonly kind: "created" | "updated" | "unchanged"; readonly messageId: string }
  | { readonly code: string; readonly kind: "failed" }
  | { readonly kind: "not_due" | "stale" };

export function createDiscordOperationsBoardService(dependencies: DiscordOperationsBoardDependencies) {
  return async function sync(input: {
    readonly bot: BoardBotClient;
    readonly config: DiscordApplicationConfig;
    readonly force: boolean;
    readonly now: Date;
  }): Promise<DiscordOperationsBoardSyncResult> {
    const claim = await dependencies.claim({ force: input.force, now: input.now });
    if (claim === null) return { kind: "not_due" };
    const snapshot = await dependencies.loadSnapshot({ date: toKstDate(input.now), now: input.now });
    const digest = discordOperationsBoardStateDigest(snapshot);
    const configuredMessage = claim.guildId === input.config.guildId && claim.channelId === input.config.channelId
      ? claim.messageId
      : null;
    if (configuredMessage !== null && claim.renderedDate === snapshot.date && claim.stateDigest === digest) {
      return (await dependencies.completeUnchanged({ claim, now: input.now }))
        ? { kind: "unchanged", messageId: configuredMessage }
        : { kind: "stale" };
    }
    const revision = claim.revision + 1;
    const payload = buildDiscordOperationsBoardPayload({ observedAt: input.now, revision, secret: input.config.botToken, snapshot });
    const delivery = configuredMessage === null
      ? await input.bot.createChannelMessage({ channelId: input.config.channelId, payload, reservationId: "discord-operations-board" })
      : await input.bot.editChannelMessage({ channelId: input.config.channelId, messageId: configuredMessage, payload });
    if (delivery.kind !== "sent") {
      await dependencies.fail({ claim, errorCode: delivery.code, now: input.now });
      return { code: delivery.code, kind: "failed" };
    }
    if (configuredMessage === null) {
      const pin = await dependencies.pin({ botToken: input.config.botToken, channelId: input.config.channelId, messageId: delivery.messageId });
      if (pin.kind === "failed") {
        await input.bot.deleteChannelMessage({ channelId: input.config.channelId, messageId: delivery.messageId });
        await dependencies.fail({ claim, errorCode: pin.code, now: input.now });
        return pin;
      }
    }
    const completed = await dependencies.complete({
      channelId: input.config.channelId,
      claim,
      guildId: input.config.guildId,
      messageId: delivery.messageId,
      now: input.now,
      renderedDate: snapshot.date,
      revision,
      stateDigest: digest
    });
    return completed
      ? { kind: configuredMessage === null ? "created" : "updated", messageId: delivery.messageId }
      : { kind: "stale" };
  };
}

const defaultService = createDiscordOperationsBoardService({
  claim: claimDiscordOperationsBoardSync,
  complete: completeDiscordOperationsBoardSync,
  completeUnchanged: completeUnchangedDiscordOperationsBoardSync,
  fail: failDiscordOperationsBoardSync,
  loadSnapshot: loadDiscordOperationsBoardSnapshot,
  pin: pinDiscordChannelMessage
});

export function syncDiscordOperationsBoard(input: {
  readonly config: DiscordApplicationConfig;
  readonly force?: boolean;
  readonly now: Date;
}): Promise<DiscordOperationsBoardSyncResult> {
  return defaultService({
    bot: createDiscordBotClient({ applicationId: input.config.applicationId, botToken: input.config.botToken }),
    config: input.config,
    force: input.force === true,
    now: input.now
  });
}

export type { DiscordOperationsBoardClaim };
