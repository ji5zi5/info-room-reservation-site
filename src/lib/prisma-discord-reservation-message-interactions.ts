import { Prisma } from "@prisma/client";

type ReceiptWrite = Readonly<{
  discordActorId: string;
  interactionId: string;
  intent: string;
  localActorId: string;
  messageId: string | null;
  reservationId: string;
  status: "TERMINAL";
  terminalOutcome: string;
  terminalResult: Prisma.InputJsonValue;
}>;

type ReceiptTransaction = {
  readonly discordInteractionReceipt: {
    readonly createMany: (
      input: Prisma.DiscordInteractionReceiptCreateManyArgs
    ) => Promise<Prisma.BatchPayload>;
    readonly findUnique: (
      input: Prisma.DiscordInteractionReceiptFindUniqueArgs
    ) => Promise<{ readonly terminalResult: Prisma.JsonValue } | null>;
  };
};

type DecisionTransaction = {
  readonly discordReservationMessage: {
    readonly updateMany: (
      input: Prisma.DiscordReservationMessageUpdateManyArgs
    ) => Promise<Prisma.BatchPayload>;
  };
};

export async function recordDiscordInteractionReceipt(
  transaction: ReceiptTransaction,
  input: ReceiptWrite
): Promise<{
  readonly kind: "inserted" | "replayed";
  readonly terminalResult: Prisma.JsonValue;
}> {
  const insertion = await transaction.discordInteractionReceipt.createMany({ data: input, skipDuplicates: true });
  const terminalResult = await findDiscordInteractionTerminalResult(transaction, input);
  if (terminalResult === null) {
    throw new DiscordInteractionReceiptConflictError(input.interactionId);
  }
  return { kind: insertion.count === 1 ? "inserted" : "replayed", terminalResult };
}

export async function findDiscordInteractionTerminalResult(
  transaction: ReceiptTransaction,
  input: Readonly<{ interactionId: string; reservationId: string }>
): Promise<Prisma.JsonValue | null> {
  const receipt = await transaction.discordInteractionReceipt.findUnique({
    where: { interactionId: input.interactionId }
  }) ?? await transaction.discordInteractionReceipt.findUnique({
    where: { reservationId: input.reservationId }
  });
  return receipt?.terminalResult ?? null;
}

export async function recordDiscordReservationDecision(
  transaction: DecisionTransaction,
  input: Readonly<{
    decision: string;
    discordActorId: string;
    localActorId: string;
    now: Date;
    reservationId: string;
    revision: "INCREMENT" | "PRESERVE";
  }>
): Promise<boolean> {
  const revisionUpdate = input.revision === "INCREMENT" ? {
    messageRevision: { increment: 1 },
    syncAttempts: 0,
    syncClaimId: null,
    syncClaimRevision: null,
    syncClaimedAt: null,
    syncError: null,
    syncNextAttemptAt: input.now,
    syncStatus: "PENDING"
  } satisfies Prisma.DiscordReservationMessageUpdateManyMutationInput : {};
  const result = await transaction.discordReservationMessage.updateMany({
    data: {
      decidedAt: input.now,
      decision: input.decision,
      decisionDiscordActorId: input.discordActorId,
      decisionLocalActorId: input.localActorId,
      ...revisionUpdate
    },
    where: { decision: null, reservationId: input.reservationId }
  });
  return result.count === 1;
}

class DiscordInteractionReceiptConflictError extends Error {
  public constructor(id: string) {
    super(`Discord interaction receipt conflict could not be replayed: ${id}`);
    this.name = "DiscordInteractionReceiptConflictError";
  }
}
