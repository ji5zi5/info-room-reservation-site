import { processDiscordInitialClaim, type InitialClaimResult } from "./discord-reservation-outbox-initial";
import { defaultDiscordReservationOutboxDependencies } from "./discord-reservation-outbox-runtime";
import { processDiscordSyncClaim, type SyncClaimResult } from "./discord-reservation-outbox-sync";
import type {
  DiscordReservationOutboxDependencies,
  DiscordReservationOutboxRunResult,
  InitialRunSummary,
  SyncRunSummary
} from "./discord-reservation-outbox-contracts";
import type {
  DiscordInitialSendClaim,
  DiscordMessageSyncClaim
} from "./prisma-discord-reservation-message-repository";
import { isNoDatabaseMockMode } from "./mock-dev-mode";

export type {
  DiscordReservationOutboxDependencies,
  DiscordReservationOutboxRunResult
} from "./discord-reservation-outbox-contracts";

export function createDiscordReservationOutbox(
  dependencies: DiscordReservationOutboxDependencies
): (input: { readonly now: Date; readonly reservationId?: string }) => Promise<Extract<DiscordReservationOutboxRunResult, { readonly kind: "processed" }>> {
  return async (input) => {
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
      initial: summarizeInitial(initialResults),
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

function summarizeInitial(results: readonly InitialClaimResult[]): InitialRunSummary {
  return {
    claimed: results.length,
    retried: results.filter((result) => result === "retried").length,
    sent: results.filter((result) => result === "sent").length,
    terminal: results.filter((result) => result === "terminal").length
  };
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
