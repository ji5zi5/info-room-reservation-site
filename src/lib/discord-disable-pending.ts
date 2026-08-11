import type { DiscordBotClient } from "./discord-bot";
import { buildDiscordReservationStaleMessage } from "./discord-reservation-messages";
import type { DiscordReservationSnapshot, DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";

const DISCORD_DISABLE_MAX_BATCHES = 10;

export type DiscordDisablePendingClaim = {
  readonly channelId: string;
  readonly claimId: string;
  readonly messageId: string;
  readonly reservationId: string;
  readonly revision: number;
};

export type DiscordDisablePendingRepository = {
  readonly claimActiveMessagesForDisable: (now: Date) => Promise<readonly DiscordDisablePendingClaim[]>;
  readonly completeDisableClaim: (claim: DiscordDisablePendingClaim, now: Date) => Promise<boolean>;
  readonly releaseDisableClaim: (claim: DiscordDisablePendingClaim) => Promise<boolean>;
};

export type DisableDiscordPendingResult = {
  readonly claimed: number;
  readonly disabled: number;
  readonly failed: number;
  readonly hasMore: boolean;
};

type DisableDiscordPendingBot = Pick<DiscordBotClient, "editChannelMessage">;

export function createDisableDiscordPending(dependencies: {
  readonly bot: DisableDiscordPendingBot;
  readonly loadSnapshot: (reservationId: string) => Promise<DiscordReservationSnapshotResult>;
  readonly repository: DiscordDisablePendingRepository;
}): (input: { readonly now: Date }) => Promise<DisableDiscordPendingResult> {
  return async ({ now }) => {
    let claimed = 0;
    let disabled = 0;
    let failed = 0;
    let hasMore = false;
    for (let batch = 0; batch < DISCORD_DISABLE_MAX_BATCHES; batch += 1) {
      const claims = await dependencies.repository.claimActiveMessagesForDisable(now);
      if (claims.length === 0) {
        hasMore = false;
        break;
      }
      claimed += claims.length;
      const outcomes = await Promise.all(claims.map(async (claim) => processClaim(dependencies, claim, now)));
      const batchFailures = outcomes.filter((outcome) => !outcome).length;
      disabled += outcomes.filter(Boolean).length;
      failed += batchFailures;
      if (batchFailures > 0) {
        hasMore = true;
        break;
      }
      hasMore = batch === DISCORD_DISABLE_MAX_BATCHES - 1;
    }
    return { claimed, disabled, failed, hasMore };
  };
}

async function processClaim(
  dependencies: {
    readonly bot: DisableDiscordPendingBot;
    readonly loadSnapshot: (reservationId: string) => Promise<DiscordReservationSnapshotResult>;
    readonly repository: DiscordDisablePendingRepository;
  },
  claim: DiscordDisablePendingClaim,
  now: Date
): Promise<boolean> {
  const snapshotResult = await dependencies.loadSnapshot(claim.reservationId);
  if (snapshotResult.kind === "not_found") {
    await dependencies.repository.releaseDisableClaim(claim);
    return false;
  }
  const edit = await dependencies.bot.editChannelMessage({
    channelId: claim.channelId,
    messageId: claim.messageId,
    payload: buildDiscordReservationStaleMessage(messageInput(snapshotResult.snapshot))
  });
  if (edit.kind !== "sent") {
    await dependencies.repository.releaseDisableClaim(claim);
    return false;
  }
  const completed = await dependencies.repository.completeDisableClaim(claim, now);
  if (!completed) {
    await dependencies.repository.releaseDisableClaim(claim);
  }
  return completed;
}

function messageInput(snapshot: DiscordReservationSnapshot) {
  return {
    applicant: snapshot.reservation.user,
    capacity: snapshot.capacity,
    closeTime: snapshot.effectiveSetting.closeTime,
    confirmedCount: snapshot.confirmedCount,
    date: snapshot.reservation.date,
    reason: snapshot.reservation.reason,
    reservationId: snapshot.reservation.id,
    studyPeriod: snapshot.reservation.studyPeriod
  };
}

export { DISCORD_DISABLE_MAX_BATCHES };
