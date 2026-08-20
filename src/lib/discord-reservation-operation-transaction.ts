import { Prisma } from "@prisma/client";
import { z } from "zod";

import { markAdministratorReservationNoShowInTransaction } from "./admin-no-show-operations";
import { cancelAdministratorReservationInTransaction } from "./admin-reservation-operations";
import {
  findDiscordInteractionTerminalResult,
  recordDiscordReservationDecision
} from "./prisma-discord-reservation-message-repository";
import { recordDiscordOperationReceipt } from "./prisma-discord-reservation-message-interactions";
import type {
  DiscordReservationOperationCommand,
  DiscordReservationOperationResult
} from "./discord-reservation-operations";

const terminalResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reservationId: z.string() }),
  z.object({ kind: z.literal("cancelled"), reservationId: z.string() }),
  z.object({ kind: z.literal("no_show"), reservationId: z.string() }),
  z.object({ kind: z.literal("stale"), reservationId: z.string() })
]);

type TransactionInput = {
  readonly actor: { readonly id: string; readonly role: "ADMIN" };
  readonly command: DiscordReservationOperationCommand;
  readonly currentApplicationId: string;
  readonly ipHash: string;
  readonly now: Date;
  readonly persistedJobRequired: boolean;
  readonly targetUserId: string;
  readonly transaction: Prisma.TransactionClient;
};

export async function processDiscordReservationOperationInTransaction(
  input: TransactionInput
): Promise<DiscordReservationOperationResult> {
  const [currentActor, reservation, message, job, controls] = await Promise.all([
    input.transaction.user.findUnique({ select: { id: true, role: true, studentNumber: true }, where: { id: input.actor.id } }),
    input.transaction.reservation.findUnique({ where: { id: input.command.reservationId } }),
    input.transaction.discordReservationMessage.findUnique({
      select: { channelId: true, decision: true, guildId: true, messageId: true, renderedSourceEpoch: true },
      where: { reservationId: input.command.reservationId }
    }),
    input.transaction.discordInteractionJob.findUnique({
      select: { sourceApplicationId: true },
      where: { interactionId: input.command.interactionId }
    }),
    input.transaction.$queryRaw<readonly { readonly enabled: boolean; readonly epoch: number }[]>(Prisma.sql`
      SELECT "enabled", "epoch" FROM "DiscordOperationsControl"
      WHERE "id" = 'discord-operations'
    `)
  ]);
  if (
    input.command.sourceApplicationId === null ||
    input.command.sourceApplicationId !== input.currentApplicationId ||
    (job === null ? input.persistedJobRequired : job.sourceApplicationId !== input.command.sourceApplicationId)
  ) return { code: "stale_application", kind: "noop" };
  const replay = await findDiscordInteractionTerminalResult(input.transaction, input.command);
  if (replay !== null) return parseTerminalResult(replay);
  if (
    currentActor?.id !== input.actor.id || currentActor.role !== "ADMIN" ||
    currentActor.studentNumber !== input.command.studentNumber
  ) return { code: "stale_actor", kind: "noop" };
  if (reservation === null || reservation.userId !== input.targetUserId) return { code: "stale_reservation", kind: "noop" };
  if (message === null) return { code: "stale_message", kind: "noop" };
  const control = controls[0];
  if (
    control?.enabled !== true || control.epoch !== input.command.renderedControlEpoch ||
    message.renderedSourceEpoch !== input.command.renderedControlEpoch
  ) return { code: "stale_control", kind: "noop" };
  if (
    message.messageId !== input.command.sourceMessageId ||
    message.guildId !== input.command.sourceGuildId || message.channelId !== input.command.sourceChannelId
  ) return { code: "stale_message", kind: "noop" };
  if (reservation.status !== "CONFIRMED") {
    return input.command.kind === "accept" || input.command.kind === "reject"
      ? settledInitialDecisionResult(input.command.reservationId, reservation.status, message.decision)
      : writeStaleReceipt(input);
  }
  switch (input.command.kind) {
    case "accept":
      return message.decision === null
        ? acceptReservation(input)
        : settledInitialDecisionResult(input.command.reservationId, reservation.status, message.decision);
    case "reject":
      return message.decision === null
        ? cancelReservation({ ...input, command: input.command }, "DISCORD_REJECTION")
        : settledInitialDecisionResult(input.command.reservationId, reservation.status, message.decision);
    case "admin_cancel":
      return message.decision === "ACCEPTED"
        ? cancelReservation({ ...input, command: input.command }, "DISCORD_ADMIN_CANCEL")
        : writeStaleReceipt(input);
    case "no_show":
      return message.decision === "ACCEPTED"
        ? markNoShow({ ...input, command: input.command })
        : writeStaleReceipt(input);
    default:
      return assertNever(input.command);
  }
}

async function acceptReservation(input: TransactionInput): Promise<DiscordReservationOperationResult> {
  await requireSourceMessageCas(input, "ACCEPTED", null, "INCREMENT");
  const action = await input.transaction.adminAction.create({ data: {
    action: "DISCORD_RESERVATION_ACCEPT", actorId: input.actor.id,
    after: JSON.stringify({ reservationStatus: "CONFIRMED" }), before: JSON.stringify({ reservationStatus: "CONFIRMED" }),
    ipHash: input.ipHash, reservationId: input.command.reservationId, targetUserId: input.targetUserId
  } });
  await input.transaction.auditLog.create({ data: {
    action: "DISCORD_RESERVATION_ACCEPT", actorId: input.actor.id,
    detail: JSON.stringify({ actionId: action.id, discordActorId: input.command.discordActorId, reservationId: input.command.reservationId }),
    userId: input.targetUserId
  } });
  return writeSuccessReceipt(input, "ACCEPT", "ACCEPTED", "accepted");
}

async function cancelReservation(
  input: TransactionInput & { readonly command: Extract<DiscordReservationOperationCommand, { readonly kind: "reject" | "admin_cancel" }> },
  source: "DISCORD_ADMIN_CANCEL" | "DISCORD_REJECTION"
): Promise<DiscordReservationOperationResult> {
  const result = await cancelAdministratorReservationInTransaction(input.transaction, {
    actor: input.actor, ipHash: input.ipHash, reason: input.command.reason,
    reservationId: input.command.reservationId, source: { kind: source }
  });
  if (result.kind !== "ok") {
    return { code: result.kind === "not_found" ? "reservation_not_found" : result.kind, kind: "noop" };
  }
  await requireSourceMessageCas(input, "CANCELLED", source === "DISCORD_REJECTION" ? null : "ACCEPTED", "PRESERVE");
  return writeSuccessReceipt(input, source === "DISCORD_REJECTION" ? "REJECT" : "ADMIN_CANCEL", "CANCELLED", "cancelled");
}

async function markNoShow(input: TransactionInput & {
  readonly command: Extract<DiscordReservationOperationCommand, { readonly kind: "no_show" }>;
}): Promise<DiscordReservationOperationResult> {
  const result = await markAdministratorReservationNoShowInTransaction(input.transaction, {
    actor: input.actor, ipHash: input.ipHash, now: input.now,
    reason: input.command.reason, reservationId: input.command.reservationId
  });
  if (result.kind !== "ok") {
    return { code: result.kind === "not_found" ? "reservation_not_found" : result.kind, kind: "noop" };
  }
  await requireSourceMessageCas(input, "NO_SHOW", "ACCEPTED", "PRESERVE");
  return writeSuccessReceipt(input, "NO_SHOW", "NO_SHOW", "no_show");
}

async function requireSourceMessageCas(
  input: TransactionInput,
  decision: string,
  expectedDecision: "ACCEPTED" | null,
  revision: "INCREMENT" | "PRESERVE"
): Promise<void> {
  const recorded = await recordDiscordReservationDecision(input.transaction, {
    decision, discordActorId: input.command.discordActorId, expectedDecision,
    localActorId: input.actor.id, now: input.now, renderedSourceEpoch: input.command.renderedControlEpoch,
    reservationId: input.command.reservationId, revision, sourceMessageId: input.command.sourceMessageId
  });
  if (!recorded) throw new DiscordReservationDecisionConflictError(input.command.reservationId);
}

function settledInitialDecisionResult(
  reservationId: string,
  reservationStatus: string,
  decision: string | null
): DiscordReservationOperationResult {
  if (reservationStatus === "CANCELLED" || decision === "CANCELLED") return { kind: "cancelled", reservationId };
  if (reservationStatus === "CONFIRMED" && decision === "ACCEPTED") return { kind: "accepted", reservationId };
  return { kind: "stale", reservationId };
}

async function writeSuccessReceipt(
  input: TransactionInput,
  intent: "ACCEPT" | "ADMIN_CANCEL" | "NO_SHOW" | "REJECT",
  terminalOutcome: "ACCEPTED" | "CANCELLED" | "NO_SHOW",
  kind: "accepted" | "cancelled" | "no_show"
): Promise<DiscordReservationOperationResult> {
  const terminalResult = { kind, reservationId: input.command.reservationId };
  const receipt = await recordDiscordOperationReceipt(input.transaction, receiptWrite(input, intent, terminalOutcome, terminalResult));
  return parseTerminalResult(receipt.terminalResult);
}

async function writeStaleReceipt(input: TransactionInput): Promise<DiscordReservationOperationResult> {
  const terminalResult = { kind: "stale", reservationId: input.command.reservationId } as const;
  const receipt = await recordDiscordOperationReceipt(
    input.transaction,
    receiptWrite(input, operationIntent(input.command.kind), "STALE", terminalResult)
  );
  return parseTerminalResult(receipt.terminalResult);
}

function receiptWrite(input: TransactionInput, intent: string, terminalOutcome: string, terminalResult: Prisma.InputJsonObject) {
  return {
    discordActorId: input.command.discordActorId, interactionId: input.command.interactionId, intent,
    localActorId: input.actor.id, messageId: input.command.sourceMessageId, reservationId: input.command.reservationId,
    terminalOutcome, terminalResult
  };
}

function operationIntent(kind: DiscordReservationOperationCommand["kind"]): string {
  switch (kind) {
    case "accept": return "ACCEPT";
    case "reject": return "REJECT";
    case "admin_cancel": return "ADMIN_CANCEL";
    case "no_show": return "NO_SHOW";
    default: return assertNever(kind);
  }
}

function parseTerminalResult(value: Prisma.JsonValue): DiscordReservationOperationResult {
  const parsed = terminalResultSchema.safeParse(value);
  return parsed.success ? parsed.data : { code: "stale_receipt", kind: "noop" };
}

function assertNever(value: never): never {
  throw new DiscordReservationTransactionVariantError(String(value));
}

class DiscordReservationDecisionConflictError extends Error {
  public constructor(reservationId: string) {
    super(`Discord reservation decision conflicted for ${reservationId}`);
    this.name = "DiscordReservationDecisionConflictError";
  }
}

class DiscordReservationTransactionVariantError extends Error {
  public override readonly name = "DiscordReservationTransactionVariantError";
}
