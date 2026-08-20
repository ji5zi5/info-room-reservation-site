import { createHash } from "node:crypto";

import { z } from "zod";

import type { DiscordInteractionJobClaim } from "./discord-interaction-job-runner";
import type { DiscordReservationOperationCommand } from "./discord-reservation-operations";
import type { DiscordInteractionStageInput } from "./prisma-discord-interaction-job-store";

const persistedIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept"), studentNumber: z.string().min(1) }),
  z.object({ kind: z.literal("admin_cancel"), reason: z.string().min(1).max(200), studentNumber: z.string().min(1) }),
  z.object({ kind: z.literal("no_show"), reason: z.string().min(1).max(200).default("Discord 관리자 노쇼 처리"), studentNumber: z.string().min(1) }),
  z.object({ kind: z.literal("reject"), reason: z.string().min(1).max(200), studentNumber: z.string().min(1) })
]);

export function buildDiscordInteractionStageInput(
  command: DiscordReservationOperationCommand,
  ipHash: string,
  activationDeadline: Date
): DiscordInteractionStageInput {
  const intent = serializeIntent(command);
  const durable = {
    commandDigest: "",
    discordActorId: command.discordActorId,
    interactionId: command.interactionId,
    intent,
    ipHash,
    localActorId: command.localActorId,
    renderedEpoch: command.renderedControlEpoch,
    reservationId: command.reservationId,
    sourceApplicationId: command.sourceApplicationId ?? "",
    sourceChannelId: command.sourceChannelId,
    sourceGuildId: command.sourceGuildId,
    sourceMessageId: command.sourceMessageId
  };
  return { ...durable, activationDeadline, commandDigest: commandDigest(durable) };
}

export function operationFromDiscordInteractionClaim(
  claim: DiscordInteractionJobClaim
): DiscordReservationOperationCommand | null {
  const parsed = persistedIntentSchema.safeParse(parsePersistedJson(claim.intent));
  if (!parsed.success) return null;
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
  const digestInput = {
    commandDigest: "",
    discordActorId: claim.discordActorId,
    interactionId: claim.interactionId,
    intent: claim.intent,
    ipHash: claim.ipHash,
    localActorId: claim.localActorId,
    renderedEpoch: claim.renderedEpoch,
    reservationId: claim.reservationId,
    sourceApplicationId: claim.sourceApplicationId ?? "",
    sourceChannelId: claim.sourceChannelId,
    sourceGuildId: claim.sourceGuildId,
    sourceMessageId: claim.sourceMessageId
  };
  if (commandDigest(digestInput) !== claim.commandDigest) return null;
  switch (parsed.data.kind) {
    case "accept": return { ...base, kind: "accept" };
    case "admin_cancel": return { ...base, kind: "admin_cancel", reason: parsed.data.reason };
    case "no_show": return { ...base, kind: "no_show", reason: parsed.data.reason };
    case "reject": return { ...base, kind: "reject", reason: parsed.data.reason };
    default: return assertNever(parsed.data);
  }
}

function serializeIntent(command: DiscordReservationOperationCommand): string {
  switch (command.kind) {
    case "accept": return JSON.stringify({ kind: command.kind, studentNumber: command.studentNumber });
    case "admin_cancel":
    case "no_show":
    case "reject": return JSON.stringify({ kind: command.kind, reason: command.reason, studentNumber: command.studentNumber });
    default: return assertNever(command);
  }
}

function commandDigest(
  input: Omit<DiscordInteractionStageInput, "activationDeadline" | "commandDigest"> & { readonly commandDigest: string }
): string {
  const canonical = JSON.stringify({
    discordActorId: input.discordActorId,
    interactionId: input.interactionId,
    intent: input.intent,
    localActorId: input.localActorId,
    renderedEpoch: input.renderedEpoch,
    reservationId: input.reservationId,
    sourceApplicationId: input.sourceApplicationId,
    sourceChannelId: input.sourceChannelId,
    sourceGuildId: input.sourceGuildId,
    sourceMessageId: input.sourceMessageId
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

function assertNever(value: never): never {
  throw new DiscordInteractionJobContractVariantError(String(value));
}

class DiscordInteractionJobContractVariantError extends Error {
  public override readonly name = "DiscordInteractionJobContractVariantError";
}
