import { prisma } from "./db";
import {
  systemDatabaseActor,
  userMutationLockKey,
  withDatabaseContext,
  withDatabaseMutation
} from "./db-context";
import { resolveLegacyDiscordDecisionContext } from "./discord-interaction-authorization";
import { processDiscordReservationOperationInTransaction } from "./discord-reservation-operation-transaction";

type OperationBase = {
  readonly discordActorId: string;
  readonly interactionId: string;
  readonly localActorId: string;
  readonly renderedControlEpoch: number;
  readonly reservationId: string;
  readonly sourceApplicationId: string | null;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceMessageId: string;
  readonly studentNumber: string;
};

export type DiscordReservationOperationCommand =
  | (OperationBase & { readonly kind: "accept" })
  | (OperationBase & { readonly kind: "reject"; readonly reason: string })
  | (OperationBase & { readonly kind: "admin_cancel"; readonly reason: string })
  | (OperationBase & { readonly kind: "no_show"; readonly reason: string });

export type DiscordReservationOperationResult =
  | { readonly kind: "accepted"; readonly reservationId: string }
  | { readonly kind: "cancelled"; readonly reservationId: string }
  | { readonly kind: "no_show"; readonly reservationId: string }
  | {
      readonly code:
        | "actor_not_admin"
        | "actor_not_found"
        | "admin_target"
        | "conflict"
        | "decision_without_receipt"
        | "invalid_status"
        | "not_closed"
        | "reservation_not_found"
        | "stale_actor"
        | "stale_application"
        | "stale_control"
        | "stale_message"
        | "stale_receipt"
        | "stale_reservation";
      readonly kind: "noop";
    }
  | { readonly kind: "stale"; readonly reservationId: string };

export type DiscordReservationDecisionResult = Exclude<DiscordReservationOperationResult, { readonly kind: "no_show" }>;

export type DiscordReservationSourceMessageTerminalState =
  | { readonly kind: "accepted" }
  | { readonly cancellationReason: string | null; readonly kind: "cancelled" }
  | { readonly kind: "stale" };

export async function processDiscordReservationOperation(input: {
  readonly command: DiscordReservationOperationCommand;
  readonly currentApplicationId: string;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordReservationOperationResult> {
  return processOperation({ ...input, persistedJobRequired: true });
}

async function processOperation(input: {
  readonly command: DiscordReservationOperationCommand;
  readonly currentApplicationId: string;
  readonly ipHash: string;
  readonly now: Date;
  readonly persistedJobRequired: boolean;
}): Promise<DiscordReservationOperationResult> {
  const resolved = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      const [actor, reservation] = await Promise.all([
        transaction.user.findUnique({
          select: { id: true, role: true, studentNumber: true },
          where: { id: input.command.localActorId }
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
  if (resolved.actor.studentNumber !== input.command.studentNumber) return { code: "stale_actor", kind: "noop" };
  if (resolved.reservation === null) return { code: "reservation_not_found", kind: "noop" };
  const actor = { id: resolved.actor.id, role: "ADMIN" as const };
  const targetUserId = resolved.reservation.userId;
  return withDatabaseMutation({
    actor,
    client: prisma,
    lockKeys: [userMutationLockKey(targetUserId)],
    operation: (transaction) => processDiscordReservationOperationInTransaction({
      ...input,
      actor,
      targetUserId,
      transaction
    })
  });
}

export async function processDiscordReservationDecision(input: {
  readonly command: {
    readonly discordActorId: string;
    readonly interactionId: string;
    readonly kind: "accept" | "reject";
    readonly reason?: string;
    readonly reservationId: string;
    readonly sourceMessageId: string;
    readonly studentNumber: string;
  };
  readonly currentApplicationId: string;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordReservationDecisionResult> {
  const legacy = await resolveLegacyDiscordDecisionContext(input.command);
  if (legacy.kind === "rejected") return { code: legacy.code, kind: "noop" };
  const base: OperationBase = {
    discordActorId: input.command.discordActorId,
    interactionId: input.command.interactionId,
    localActorId: legacy.localActorId,
    renderedControlEpoch: legacy.renderedControlEpoch,
    reservationId: input.command.reservationId,
    sourceApplicationId: input.currentApplicationId,
    sourceChannelId: legacy.channelId,
    sourceGuildId: legacy.guildId,
    sourceMessageId: input.command.sourceMessageId,
    studentNumber: input.command.studentNumber
  };
  const result = await processOperation({
    command: input.command.kind === "accept"
      ? { ...base, kind: "accept" }
      : { ...base, kind: "reject", reason: input.command.reason ?? "Discord 관리자 거절" },
    currentApplicationId: input.currentApplicationId,
    ipHash: input.ipHash,
    now: input.now,
    persistedJobRequired: false
  });
  if (result.kind === "no_show") throw new DiscordReservationDecisionVariantError(result.kind);
  return result;
}

export function selectDiscordReservationSourceMessageTerminalState(input: {
  readonly cancellationReason: string | null;
  readonly decision: "ACCEPTED" | "CANCELLED" | null;
  readonly reservationStatus: "CANCELLED" | "CONFIRMED" | "NO_SHOW";
}): DiscordReservationSourceMessageTerminalState {
  switch (input.reservationStatus) {
    case "CANCELLED": return { cancellationReason: input.cancellationReason, kind: "cancelled" };
    case "NO_SHOW": return { kind: "stale" };
    case "CONFIRMED": return input.decision === "ACCEPTED" ? { kind: "accepted" } : { kind: "stale" };
    default: return assertNever(input.reservationStatus);
  }
}

function assertNever(value: never): never {
  throw new DiscordReservationDecisionVariantError(String(value));
}

class DiscordReservationDecisionVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord reservation decision variant: ${value}`);
    this.name = "DiscordReservationDecisionVariantError";
  }
}
