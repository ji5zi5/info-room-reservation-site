import type { DiscordBotClient } from "./discord-bot";
import { buildDiscordReservationStaleMessage } from "./discord-reservation-messages";
import type { DiscordReservationSnapshot, DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";

const DISCORD_DISABLE_MAX_BATCHES = 10;
const DISCORD_DISABLE_DRAIN_CHECKS = 200;
const DISCORD_DISABLE_DRAIN_INTERVAL_MS = 50;

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

export type DiscordOperationsControl = {
  readonly enabled: boolean;
  readonly epoch: number;
  readonly pendingRemoteCleanup: boolean;
};

export type DiscordOperationsFenceRepository = {
  readonly beginDisable: (now: Date) => Promise<{
    readonly epoch: number;
    readonly preFenceTransportCount: number;
  }>;
  readonly countOldReservationMutations: (fencedEpoch: number) => Promise<number>;
  readonly reenable: (input: {
    readonly acknowledgeResidualInertControls: boolean;
    readonly now: Date;
  }) => Promise<
    | { readonly kind: "ack_required" }
    | { readonly control: DiscordOperationsControl; readonly kind: "enabled" }
  >;
  readonly setPendingRemoteCleanup: (pending: boolean, now: Date) => Promise<void>;
};

export type FencedDiscordDisableResult = DisableDiscordPendingResult & {
  readonly drainedMutations: number;
  readonly epoch: number;
  readonly pendingRemoteCleanup: boolean;
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

export function createFencedDiscordDisable(dependencies: {
  readonly bot: DisableDiscordPendingBot;
  readonly loadSnapshot: (reservationId: string) => Promise<DiscordReservationSnapshotResult>;
  readonly maxDrainChecks?: number;
  readonly operations: DiscordOperationsFenceRepository;
  readonly repository: DiscordDisablePendingRepository;
  readonly wait?: () => Promise<void>;
}): (input: { readonly now: Date }) => Promise<FencedDiscordDisableResult> {
  return async ({ now }) => {
    const fence = await dependencies.operations.beginDisable(now);
    try {
      const wait = dependencies.wait ?? (() => new Promise((resolve) => {
        setTimeout(resolve, DISCORD_DISABLE_DRAIN_INTERVAL_MS);
      }));
      const maxDrainChecks = dependencies.maxDrainChecks ?? DISCORD_DISABLE_DRAIN_CHECKS;
      let drainedMutations = 0;
      for (let check = 0; check < maxDrainChecks; check += 1) {
        const activeMutations = await dependencies.operations.countOldReservationMutations(fence.epoch);
        drainedMutations = Math.max(drainedMutations, activeMutations);
        if (activeMutations === 0) {
          const cleanup = await createDisableDiscordPending(dependencies)({ now });
          const pendingRemoteCleanup = fence.preFenceTransportCount > 0 || cleanup.failed > 0 || cleanup.hasMore;
          await dependencies.operations.setPendingRemoteCleanup(pendingRemoteCleanup, now);
          return { ...cleanup, drainedMutations, epoch: fence.epoch, pendingRemoteCleanup };
        }
        if (check + 1 < maxDrainChecks) await wait();
      }
      throw new DiscordDisablePendingError(
        "MUTATION_DRAIN_TIMEOUT",
        "Old Discord reservation mutations did not drain before the disable deadline"
      );
    } catch (error) {
      await dependencies.operations.setPendingRemoteCleanup(true, now);
      throw error;
    }
  };
}

export async function reenableDiscordOperations(input: {
  readonly acknowledgeResidualInertControls: boolean;
  readonly now: Date;
  readonly repository: DiscordOperationsFenceRepository;
}): Promise<DiscordOperationsControl> {
  const result = await input.repository.reenable({
    acknowledgeResidualInertControls: input.acknowledgeResidualInertControls,
    now: input.now
  });
  if (result.kind === "ack_required") {
    throw new DiscordDisablePendingError(
      "RESIDUAL_ACK_REQUIRED",
      "Re-enable requires acknowledgement that residual remote controls are inert"
    );
  }
  return result.control;
}

export class DiscordDisablePendingError extends Error {
  public readonly code: "MUTATION_DRAIN_TIMEOUT" | "RESIDUAL_ACK_REQUIRED";

  public constructor(code: DiscordDisablePendingError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "DiscordDisablePendingError";
  }
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
