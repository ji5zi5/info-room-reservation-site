import type { DiscordBotClient } from "./discord-bot";
import type { MaintenanceExpiryBatchResult } from "./maintenance-service";

const DISCORD_RETENTION_BATCH_SIZE = 100;

export type DiscordRetentionCandidate = {
  readonly channelId: string | null;
  readonly expiresAt: Date;
  readonly messageId: string | null;
  readonly reservationId: string;
  readonly updatedAt: Date;
};

export type DiscordRetentionRepository = {
  readonly deleteExpiredCandidate: (candidate: DiscordRetentionCandidate, now: Date) => Promise<boolean>;
  readonly findExpiredCandidates: (now: Date) => Promise<readonly DiscordRetentionCandidate[]>;
};

type DiscordRetentionBot = Pick<DiscordBotClient, "deleteChannelMessage">;

export function createDiscordReservationRetention(dependencies: {
  readonly bot: DiscordRetentionBot;
  readonly hasApplicationConfig: () => boolean;
  readonly repository: DiscordRetentionRepository;
}): (now: Date) => Promise<MaintenanceExpiryBatchResult> {
  return async (now) => {
    const candidates = await dependencies.repository.findExpiredCandidates(now);
    const selected = candidates.slice(0, DISCORD_RETENTION_BATCH_SIZE);
    const hasAdditionalCandidates = candidates.length > DISCORD_RETENTION_BATCH_SIZE;
    const applicationConfigured = dependencies.hasApplicationConfig();
    const outcomes = await Promise.all(selected.map(async (candidate) => {
      if (candidate.messageId !== null) {
        if (!applicationConfigured || candidate.channelId === null) {
          return false;
        }
        const remote = await dependencies.bot.deleteChannelMessage({
          channelId: candidate.channelId,
          messageId: candidate.messageId
        });
        if (remote.kind === "failed") {
          return false;
        }
      }
      return dependencies.repository.deleteExpiredCandidate(candidate, now);
    }));
    const processedCount = outcomes.filter(Boolean).length;
    const failedCount = selected.length - processedCount;
    return {
      hasMore: hasAdditionalCandidates && failedCount === 0,
      processedCount,
      remainingLowerBound: failedCount + (hasAdditionalCandidates ? 1 : 0)
    };
  };
}

export { DISCORD_RETENTION_BATCH_SIZE };
