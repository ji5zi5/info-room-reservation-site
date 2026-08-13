import { createHash } from "node:crypto";

import { z } from "zod";

import {
  runDiscordInteractionJobs,
  type DiscordInteractionDispatchResult,
  type DiscordInteractionJobClaim
} from "./discord-interaction-job-runner";
import {
  processDiscordInitialClaim,
  reconcileExpiredDiscordInitialPosts
} from "./discord-reservation-outbox-initial";
import {
  defaultDiscordReservationOutboxDependencies,
  dispatchDiscordReservationOperation
} from "./discord-reservation-outbox-runtime";
import type { DiscordReservationOperationCommand } from "./discord-reservation-operations";
import { processDiscordSyncClaim, type SyncClaimResult } from "./discord-reservation-outbox-sync";
import {
  summarizeInitialRun,
  type DiscordReservationOutboxDependencies,
  type DiscordReservationOutboxRunResult,
  type SyncRunSummary
} from "./discord-reservation-outbox-contracts";
import type {
  DiscordInitialSendClaim,
  DiscordMessageSyncClaim
} from "./prisma-discord-reservation-message-repository";
import { isNoDatabaseMockMode } from "./mock-dev-mode";
import {
  getDiscordInteractionBacklogSummary,
  prismaDiscordInteractionJobStore
} from "./prisma-discord-interaction-job-store";

const persistedIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept"), studentNumber: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("admin_cancel"), reason: z.string().min(1), studentNumber: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("no_show"), studentNumber: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reject"), reason: z.string().min(1), studentNumber: z.string().min(1) }).strict()
]);

export type {
  DiscordReservationOutboxDependencies,
  DiscordReservationOutboxRunResult
} from "./discord-reservation-outbox-contracts";

export function createDiscordReservationOutbox(
  dependencies: DiscordReservationOutboxDependencies
): (input: { readonly now: Date; readonly reservationId?: string }) => Promise<Extract<DiscordReservationOutboxRunResult, { readonly kind: "processed" }>> {
  return async (input) => {
    if (input.reservationId === undefined) {
      await reconcileExpiredDiscordInitialPosts(dependencies, input.now);
    }
    const initialClaims = input.reservationId === undefined
      ? await dependencies.repository.claimInitialSends(input.now)
      : optionalClaim(await dependencies.repository.claimInitialSend(input.now, input.reservationId));
    const initialResults = await Promise.all(
      initialClaims.map((claim) => processDiscordInitialClaim(dependencies, claim, input.now))
    );
    const syncClaims = input.reservationId === undefined
      ? await dependencies.repository.claimMessageSyncs(input.now)
      : optionalSyncClaim(await dependencies.repository.claimMessageSync(input.now, input.reservationId));
    const syncResults = await Promise.all(
      syncClaims.map((claim) => processDiscordSyncClaim(dependencies, claim, input.now))
    );
    return {
      initial: summarizeInitialRun(initialResults),
      kind: "processed",
      sync: summarizeSync(syncResults)
    };
  };
}

export async function runDiscordReservationOutbox(input: {
  readonly now: Date;
  readonly reservationId?: string;
}): Promise<DiscordReservationOutboxRunResult> {
  if (isNoDatabaseMockMode()) {
    return { kind: "skipped", reason: "no_database_mock" };
  }
  return createDiscordReservationOutbox(defaultDiscordReservationOutboxDependencies())(input);
}

export async function runDiscordInteractionCronWorker(now: Date) {
  const counts = await runDiscordInteractionJobs({
    dispatch: (claim) => dispatchInteractionClaim(claim, now),
    now,
    store: prismaDiscordInteractionJobStore
  });
  const backlog = await getDiscordInteractionBacklogSummary(now);
  return {
    ...counts,
    backlog: {
      count: backlog.count,
      oldestAt: backlog.oldestCreatedAt?.toISOString() ?? null
    }
  };
}

async function dispatchInteractionClaim(
  claim: DiscordInteractionJobClaim,
  now: Date
): Promise<DiscordInteractionDispatchResult> {
  const command = interactionOperationFromClaim(claim);
  return command === null
    ? { errorCode: "persisted_command_invalid", errorType: "INTEGRITY", kind: "terminal_failure" }
    : dispatchDiscordReservationOperation({ command, ipHash: claim.ipHash, now });
}

function interactionOperationFromClaim(
  claim: DiscordInteractionJobClaim
): DiscordReservationOperationCommand | null {
  const parsed = persistedIntentSchema.safeParse(parsePersistedJson(claim.intent));
  if (!parsed.success || claim.sourceApplicationId === null || interactionDigest(claim) !== claim.commandDigest) {
    return null;
  }
  const base = {
    discordActorId: claim.discordActorId,
    interactionId: claim.interactionId,
    localActorId: claim.localActorId,
    renderedControlEpoch: claim.renderedEpoch,
    reservationId: claim.reservationId,
    sourceApplicationId: claim.sourceApplicationId,
    sourceChannelId: claim.sourceChannelId,
    sourceGuildId: claim.sourceGuildId,
    sourceMessageId: claim.sourceMessageId,
    studentNumber: parsed.data.studentNumber
  };
  switch (parsed.data.kind) {
    case "accept": return { ...base, kind: "accept" };
    case "admin_cancel": return { ...base, kind: "admin_cancel", reason: parsed.data.reason };
    case "no_show": return { ...base, kind: "no_show" };
    case "reject": return { ...base, kind: "reject", reason: parsed.data.reason };
  }
}

function interactionDigest(claim: DiscordInteractionJobClaim): string {
  const canonical = JSON.stringify({
    discordActorId: claim.discordActorId,
    interactionId: claim.interactionId,
    intent: claim.intent,
    localActorId: claim.localActorId,
    renderedEpoch: claim.renderedEpoch,
    reservationId: claim.reservationId,
    sourceApplicationId: claim.sourceApplicationId ?? "",
    sourceChannelId: claim.sourceChannelId,
    sourceGuildId: claim.sourceGuildId,
    sourceMessageId: claim.sourceMessageId
  });
  return `sha256:${createHash("sha256").update("discord-interaction-job:v1\0").update(canonical).digest("hex")}`;
}

function parsePersistedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function summarizeSync(results: readonly SyncClaimResult[]): SyncRunSummary {
  return {
    abandoned: results.filter((result) => result === "abandoned").length,
    claimed: results.length,
    retried: results.filter((result) => result === "retried").length,
    synced: results.filter((result) => result === "synced").length
  };
}

function optionalClaim(claim: DiscordInitialSendClaim | null): readonly DiscordInitialSendClaim[] {
  return claim === null ? [] : [claim];
}

function optionalSyncClaim(claim: DiscordMessageSyncClaim | null): readonly DiscordMessageSyncClaim[] {
  return claim === null ? [] : [claim];
}
