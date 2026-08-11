import { Prisma, type DiscordReservationMessage } from "@prisma/client";

import { withDiscordReservationMessageSystemContext } from "./prisma-discord-reservation-message-context";

const DISCORD_MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const DISCORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function beginInitialSendTerminalDelivery(input: {
  readonly claimId: string;
  readonly outcome: string;
  readonly reservationId: string;
}): Promise<boolean> {
  return conditionalInitialSendUpdate(input.reservationId, {
    initialSendOutcome: input.outcome
  }, {
    initialSendClaimId: input.claimId,
    initialSendStatus: "SENDING"
  });
}

export function cappedDiscordRetryAt(now: Date, attempts: number): Date {
  const delay = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), DISCORD_MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

export function createDiscordReservationMessage(
  transaction: Prisma.TransactionClient,
  input: Readonly<{ nonce: string; now: Date; reservationId: string }>
): Promise<DiscordReservationMessage> {
  return transaction.discordReservationMessage.create({
    data: {
      expiresAt: new Date(input.now.getTime() + DISCORD_RETENTION_MS),
      initialSendNextAttemptAt: input.now,
      nonce: input.nonce,
      reservationId: input.reservationId
    }
  });
}

export function createDiscordReservationMessageInSystemContext(input: Readonly<{
  nonce: string;
  now: Date;
  reservationId: string;
}>): Promise<DiscordReservationMessage> {
  return withDiscordReservationMessageSystemContext((transaction) =>
    createDiscordReservationMessage(transaction, input)
  );
}

export function saveInitialSendFailure(input: {
  readonly attempts: number;
  readonly claimId: string;
  readonly error: string;
  readonly now: Date;
  readonly outcome: string;
  readonly reservationId: string;
  readonly retryable: boolean;
}): Promise<boolean> {
  return conditionalInitialSendUpdate(input.reservationId, {
    initialSendClaimId: null,
    initialSendClaimedAt: null,
    initialSendError: input.error,
    initialSendNextAttemptAt: input.retryable ? cappedDiscordRetryAt(input.now, input.attempts) : null,
    initialSendOutcome: input.outcome,
    initialSendStatus: input.retryable ? "RETRY" : "ABANDONED",
    ...(!input.retryable ? { syncStatus: "ABANDONED" } : {})
  }, { initialSendClaimId: input.claimId, initialSendStatus: "SENDING" });
}

export function saveInitialSendSuccess(input: {
  readonly channelId: string;
  readonly claimId: string;
  readonly guildId: string;
  readonly messageId: string;
  readonly reservationId: string;
  readonly sentAt: Date;
}): Promise<boolean> {
  return withDiscordReservationMessageSystemContext(async (transaction) => {
    const common = {
      channelId: input.channelId,
      guildId: input.guildId,
      initialSendClaimId: null,
      initialSendClaimedAt: null,
      initialSendNextAttemptAt: null,
      initialSendOutcome: "SENT",
      initialSendStatus: "SENT",
      messageId: input.messageId
    } satisfies Prisma.DiscordReservationMessageUpdateManyMutationInput;
    const where = {
      initialSendClaimId: input.claimId,
      initialSendStatus: "SENDING",
      reservationId: input.reservationId
    } satisfies Prisma.DiscordReservationMessageWhereInput;
    const current = await transaction.discordReservationMessage.updateMany({
      data: { ...common, syncNextAttemptAt: null, syncStatus: "SYNCED" },
      where: { ...where, messageRevision: 0 }
    });
    if (current.count === 1) return true;
    const newer = await transaction.discordReservationMessage.updateMany({
      data: { ...common, syncNextAttemptAt: input.sentAt, syncStatus: "PENDING" },
      where: { ...where, messageRevision: { gt: 0 } }
    });
    return newer.count === 1;
  });
}

function conditionalInitialSendUpdate(
  reservationId: string,
  data: Prisma.DiscordReservationMessageUpdateManyMutationInput,
  where: Prisma.DiscordReservationMessageWhereInput
): Promise<boolean> {
  return withDiscordReservationMessageSystemContext(async (transaction) =>
    (await transaction.discordReservationMessage.updateMany({
      data,
      where: { ...where, reservationId }
    })).count === 1
  );
}
