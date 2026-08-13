import { Prisma } from "@prisma/client";
import { z } from "zod";

const receiptReplaySchema = z.object({
  reservationId: z.string(),
  status: z.literal("TERMINAL"),
  terminalResult: z.json()
});

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
    ) => Promise<unknown>;
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

export function recordDiscordOperationReceipt(
  transaction: ReceiptTransaction,
  input: Readonly<{
    discordActorId: string;
    interactionId: string;
    intent: string;
    localActorId: string;
    messageId: string;
    reservationId: string;
    terminalOutcome: string;
    terminalResult: Prisma.InputJsonObject;
  }>
): Promise<{ readonly kind: "inserted" | "replayed"; readonly terminalResult: Prisma.JsonValue }> {
  return recordDiscordInteractionReceipt(transaction, { ...input, status: "TERMINAL" });
}

export async function findDiscordInteractionTerminalResult(
  transaction: ReceiptTransaction,
  input: Readonly<{ interactionId: string; reservationId: string }>
): Promise<Prisma.JsonValue | null> {
  const receipt = await transaction.discordInteractionReceipt.findUnique({
    select: { reservationId: true, status: true, terminalResult: true },
    where: { interactionId: input.interactionId }
  });
  const parsed = receiptReplaySchema.safeParse(receipt);
  return parsed.success && parsed.data.reservationId === input.reservationId
    ? parsed.data.terminalResult
    : null;
}

export async function recordDiscordReservationDecision(
  transaction: DecisionTransaction,
  input: Readonly<{
    decision: string;
    discordActorId: string;
    expectedDecision: "ACCEPTED" | null;
    localActorId: string;
    now: Date;
    reservationId: string;
    renderedSourceEpoch: number;
    revision: "INCREMENT" | "PRESERVE";
    sourceMessageId: string;
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
    where: {
      decision: input.expectedDecision,
      messageId: input.sourceMessageId,
      renderedSourceEpoch: input.renderedSourceEpoch,
      reservationId: input.reservationId
    }
  });
  return result.count === 1;
}

class DiscordInteractionReceiptConflictError extends Error {
  public constructor(id: string) {
    super(`Discord interaction receipt conflict could not be replayed: ${id}`);
    this.name = "DiscordInteractionReceiptConflictError";
  }
}
