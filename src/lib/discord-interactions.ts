import type { DiscordReservationVerifiedCustomId } from "./discord-interaction-contracts";
import type { DiscordReservationOperationCommand } from "./discord-reservation-operations";

export {
  buildDiscordReservationCustomId,
  parseDiscordReservationInteraction,
  type DiscordReservationCustomIdAction,
  type DiscordReservationInteraction,
  type DiscordReservationInteractionCommand,
  type DiscordReservationMessageLedgerSnapshot
} from "./discord-interaction-contracts";
export {
  authorizeDiscordPingInteraction,
  authorizeDiscordReservationInteraction,
  type DiscordPingInteractionAuthorization,
  type DiscordReservationInteractionAuthorization
} from "./discord-interaction-authorization";
export {
  buildDiscordDeferredEphemeralResponse,
  buildDiscordImmediateEphemeralErrorResponse,
  buildDiscordPongResponse,
  buildDiscordRejectReasonModal,
  type DiscordInteractionResponse
} from "./discord-interaction-responses";

export function adaptDiscordReservationOperationCommand(input: {
  readonly command: DiscordReservationVerifiedCustomId & { readonly reason?: string };
  readonly discordActorId: string;
  readonly expectedSourceIdentity: string;
  readonly interactionId: string;
  readonly localActorId: string;
  readonly sourceApplicationId: string;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceMessageId: string;
  readonly studentNumber: string;
}): DiscordReservationOperationCommand | null {
  if (input.command.renderedEpoch === undefined || input.command.sourceIdentity !== input.expectedSourceIdentity) return null;
  const base = {
    discordActorId: input.discordActorId,
    interactionId: input.interactionId,
    localActorId: input.localActorId,
    renderedControlEpoch: input.command.renderedEpoch,
    reservationId: input.command.reservationId,
    sourceApplicationId: input.sourceApplicationId,
    sourceChannelId: input.sourceChannelId,
    sourceGuildId: input.sourceGuildId,
    sourceMessageId: input.sourceMessageId,
    studentNumber: input.studentNumber
  };
  switch (input.command.kind) {
    case "accept": return { ...base, kind: "accept" };
    case "no_show": return input.command.reason === undefined ? null : { ...base, kind: "no_show", reason: input.command.reason };
    case "admin_cancel": return input.command.reason === undefined ? null : { ...base, kind: "admin_cancel", reason: input.command.reason };
    case "reject": return input.command.reason === undefined ? null : { ...base, kind: "reject", reason: input.command.reason };
    default: return assertNever(input.command.kind);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Discord reservation action: ${String(value)}`);
}
