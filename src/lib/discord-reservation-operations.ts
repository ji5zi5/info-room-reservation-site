import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { cancelAdministratorReservationInTransaction } from "./admin-reservation-operations";
import { prisma } from "./db";
import { systemDatabaseActor, userMutationLockKey, withDatabaseContext, withDatabaseMutation } from "./db-context";
import type { DiscordReservationInteractionCommand } from "./discord-interactions";
import { findDiscordInteractionTerminalResult, recordDiscordInteractionReceipt, recordDiscordReservationDecision } from "./prisma-discord-reservation-message-repository";

type DiscordReservationDecisionCommand = Extract<DiscordReservationInteractionCommand, { readonly kind: "accept" | "reject" }>;

export type DiscordReservationDecisionResult =
  | { readonly kind: "accepted"; readonly reservationId: string }
  | { readonly kind: "cancelled"; readonly reservationId: string }
  | {
      readonly code:
        | "actor_not_admin"
        | "actor_not_found"
        | "decision_without_receipt"
        | "reservation_not_found"
        | "stale_actor"
        | "stale_message"
        | "stale_receipt"
        | "stale_reservation";
      readonly kind: "noop";
    }
  | { readonly kind: "stale"; readonly reservationId: string };

export type DiscordReservationSourceMessageTerminalState =
  | { readonly kind: "accepted" }
  | { readonly cancellationReason: string | null; readonly kind: "cancelled" }
  | { readonly kind: "stale" };

const terminalResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reservationId: z.string() }),
  z.object({ kind: z.literal("cancelled"), reservationId: z.string() }),
  z.object({ kind: z.literal("stale"), reservationId: z.string() })
]);

export async function processDiscordReservationDecision(input: {
  readonly command: DiscordReservationDecisionCommand;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordReservationDecisionResult> {
  const resolved = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      const [actor, reservation] = await Promise.all([
        transaction.user.findUnique({
          select: { id: true, role: true },
          where: { studentNumber: input.command.studentNumber }
        }),
        transaction.reservation.findUnique({
          select: { id: true, status: true, userId: true },
          where: { id: input.command.reservationId }
        })
      ]);
      return { actor, reservation };
    }
  });
  if (resolved.actor === null) return { code: "actor_not_found", kind: "noop" };
  if (resolved.actor.role !== "ADMIN") return { code: "actor_not_admin", kind: "noop" };
  if (resolved.reservation === null) return { code: "reservation_not_found", kind: "noop" };
  const actor = { id: resolved.actor.id, role: "ADMIN" as const };
  const targetUserId = resolved.reservation.userId;
  return withDatabaseMutation({
    actor,
    client: prisma,
    lockKeys: [userMutationLockKey(resolved.reservation.userId)],
    operation: async (transaction) => processInTransaction({
      actor,
      command: input.command,
      ipHash: input.ipHash,
      now: input.now,
      targetUserId,
      transaction
    })
  });
}

export function selectDiscordReservationSourceMessageTerminalState(input: {
  readonly cancellationReason: string | null;
  readonly decision: "ACCEPTED" | "CANCELLED" | null;
  readonly reservationStatus: "CANCELLED" | "CONFIRMED" | "NO_SHOW";
}): DiscordReservationSourceMessageTerminalState {
  switch (input.reservationStatus) {
    case "CANCELLED":
      return { cancellationReason: input.cancellationReason, kind: "cancelled" };
    case "NO_SHOW":
      return { kind: "stale" };
    case "CONFIRMED":
      switch (input.decision) {
        case "ACCEPTED":
          return { kind: "accepted" };
        case "CANCELLED":
        case null:
          return { kind: "stale" };
        default:
          return assertNever(input.decision);
      }
    default:
      return assertNever(input.reservationStatus);
  }
}

async function processInTransaction(input: {
  readonly actor: { readonly id: string; readonly role: "ADMIN" };
  readonly command: DiscordReservationDecisionCommand;
  readonly ipHash: string;
  readonly now: Date;
  readonly targetUserId: string;
  readonly transaction: Prisma.TransactionClient;
}): Promise<DiscordReservationDecisionResult> {
  const [currentActor, reservation, message] = await Promise.all([
    input.transaction.user.findUnique({
      select: { id: true, role: true },
      where: { studentNumber: input.command.studentNumber }
    }),
    input.transaction.reservation.findUnique({ where: { id: input.command.reservationId } }),
    input.transaction.discordReservationMessage.findUnique({
      select: { decision: true, messageId: true },
      where: { reservationId: input.command.reservationId }
    })
  ]);
  if (currentActor?.id !== input.actor.id || currentActor.role !== "ADMIN") {
    return { code: "stale_actor", kind: "noop" };
  }
  if (reservation === null || reservation.userId !== input.targetUserId) {
    return { code: "stale_reservation", kind: "noop" };
  }
  const replay = await findDiscordInteractionTerminalResult(input.transaction, input.command);
  if (replay !== null) return parseTerminalResult(replay);
  if (message === null || message.messageId !== input.command.sourceMessageId) {
    return { code: "stale_message", kind: "noop" };
  }
  if (message.decision !== null) return { code: "decision_without_receipt", kind: "noop" };
  if (reservation.status !== "CONFIRMED") {
    return writeStaleReceipt(input);
  }

  switch (input.command.kind) {
    case "accept":
      return acceptReservation(input, reservation.userId);
    case "reject":
      return rejectReservation({ ...input, command: input.command });
    default:
      return assertNever(input.command);
  }
}

async function acceptReservation(input: Parameters<typeof processInTransaction>[0], targetUserId: string): Promise<DiscordReservationDecisionResult> {
  const terminalResult = { kind: "accepted", reservationId: input.command.reservationId } as const;
  const receipt = await recordDiscordInteractionReceipt(input.transaction, receiptWrite(input, {
    intent: "ACCEPT",
    terminalOutcome: "ACCEPTED",
    terminalResult
  }));
  if (receipt.kind === "replayed") return parseTerminalResult(receipt.terminalResult);
  const recorded = await recordDiscordReservationDecision(input.transaction, {
    decision: "ACCEPTED",
    discordActorId: input.command.discordActorId,
    localActorId: input.actor.id,
    now: input.now,
    reservationId: input.command.reservationId,
    revision: "INCREMENT"
  });
  if (!recorded) throw new DiscordReservationDecisionConflictError(input.command.reservationId);
  const action = await input.transaction.adminAction.create({ data: {
    action: "DISCORD_RESERVATION_ACCEPT",
    actorId: input.actor.id,
    after: JSON.stringify({ reservationStatus: "CONFIRMED" }),
    before: JSON.stringify({ reservationStatus: "CONFIRMED" }),
    ipHash: input.ipHash,
    reservationId: input.command.reservationId,
    targetUserId
  } });
  await input.transaction.auditLog.create({ data: {
    action: "DISCORD_RESERVATION_ACCEPT",
    actorId: input.actor.id,
    detail: JSON.stringify({ actionId: action.id, discordActorId: input.command.discordActorId, reservationId: input.command.reservationId }),
    userId: targetUserId
  } });
  return terminalResult;
}

async function rejectReservation(input: Parameters<typeof processInTransaction>[0] & {
  readonly command: Extract<DiscordReservationDecisionCommand, { readonly kind: "reject" }>;
}): Promise<DiscordReservationDecisionResult> {
  const terminalResult = { kind: "cancelled", reservationId: input.command.reservationId } as const;
  const receipt = await recordDiscordInteractionReceipt(input.transaction, receiptWrite(input, {
    intent: "REJECT",
    terminalOutcome: "CANCELLED",
    terminalResult
  }));
  if (receipt.kind === "replayed") return parseTerminalResult(receipt.terminalResult);
  const recorded = await recordDiscordReservationDecision(input.transaction, {
    decision: "CANCELLED",
    discordActorId: input.command.discordActorId,
    localActorId: input.actor.id,
    now: input.now,
    reservationId: input.command.reservationId,
    revision: "PRESERVE"
  });
  if (!recorded) throw new DiscordReservationDecisionConflictError(input.command.reservationId);
  const cancellation = await cancelAdministratorReservationInTransaction(input.transaction, {
    actor: input.actor,
    ipHash: input.ipHash,
    reason: input.command.reason,
    reservationId: input.command.reservationId,
    source: { kind: "DISCORD_REJECTION" }
  });
  if (cancellation.kind !== "ok") throw new DiscordReservationDecisionConflictError(input.command.reservationId);
  return terminalResult;
}

async function writeStaleReceipt(input: Parameters<typeof processInTransaction>[0]): Promise<DiscordReservationDecisionResult> {
  const terminalResult = { kind: "stale", reservationId: input.command.reservationId } as const;
  const intent = input.command.kind === "accept" ? "ACCEPT" : "REJECT";
  const receipt = await recordDiscordInteractionReceipt(input.transaction, receiptWrite(input, {
    intent,
    terminalOutcome: "STALE",
    terminalResult
  }));
  return parseTerminalResult(receipt.terminalResult);
}

function receiptWrite(input: Parameters<typeof processInTransaction>[0], terminal: {
  readonly intent: "ACCEPT" | "REJECT";
  readonly terminalOutcome: "ACCEPTED" | "CANCELLED" | "STALE";
  readonly terminalResult: Prisma.InputJsonObject;
}) {
  return {
    discordActorId: input.command.discordActorId,
    interactionId: input.command.interactionId,
    intent: terminal.intent,
    localActorId: input.actor.id,
    messageId: input.command.sourceMessageId,
    reservationId: input.command.reservationId,
    status: "TERMINAL" as const,
    terminalOutcome: terminal.terminalOutcome,
    terminalResult: terminal.terminalResult
  };
}

function parseTerminalResult(value: Prisma.JsonValue): DiscordReservationDecisionResult {
  const parsed = terminalResultSchema.safeParse(value);
  return parsed.success ? parsed.data : { code: "stale_receipt", kind: "noop" };
}

function assertNever(value: never): never {
  throw new DiscordReservationDecisionVariantError(String(value));
}

class DiscordReservationDecisionConflictError extends Error {
  public constructor(reservationId: string) {
    super(`Discord reservation decision conflicted for ${reservationId}`);
    this.name = "DiscordReservationDecisionConflictError";
  }
}

class DiscordReservationDecisionVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord reservation decision variant: ${value}`);
    this.name = "DiscordReservationDecisionVariantError";
  }
}
