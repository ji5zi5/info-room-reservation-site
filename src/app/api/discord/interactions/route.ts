import { after, NextResponse } from "next/server";

import { DiscordApplicationConfigError, parseDiscordApplicationConfig } from "@/lib/discord-app-config";
import { completeDiscordAdminInteraction } from "@/lib/discord-admin-interaction-completion";
import { parseDiscordAdminInteraction, type DiscordAdminInteraction } from "@/lib/discord-admin-interaction-contracts";
import { waitForDiscordAdminPreparation } from "@/lib/discord-admin-interaction-deadline";
import {
  prepareDiscordAdminInteraction,
  type PreparedDiscordAdminInteraction
} from "@/lib/discord-admin-interaction-ack";
import {
  buildDiscordDeferredPrivateResponse,
  buildDiscordDeferredPublicResponse
} from "@/lib/discord-admin-interaction-responses";
import {
  acknowledgeDiscordReservationInteraction,
  authorizeDiscordInteractionModal,
  runExactPendingDiscordInteraction,
  type DiscordInteractionAcknowledgement
} from "@/lib/discord-interaction-handler";
import { verifyDiscordInteractionRequest } from "@/lib/discord-interaction-security";
import {
  authorizeDiscordPingInteraction,
  buildDiscordReservationCustomId,
  buildDiscordDeferredEphemeralResponse,
  buildDiscordImmediateEphemeralErrorResponse,
  buildDiscordPongResponse,
  buildDiscordRejectReasonModal,
  parseDiscordReservationInteraction,
  type DiscordReservationInteraction
} from "@/lib/discord-interactions";
import { hashRequestClientIp } from "@/lib/request-source";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const config = readDiscordApplicationConfig();
  if (config === null) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const verified = await verifyDiscordInteractionRequest(request, config.publicKey);
  if (verified.kind === "rejected") {
    return NextResponse.json({ error: "invalid_request" }, { status: 401 });
  }

  const decoded = parseRawJson(verified.body);
  if (decoded.kind === "malformed") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const adminInteraction = parseDiscordAdminInteraction(decoded.value, config.botToken);
  if (adminInteraction.kind !== "invalid") {
    return respondToAdminInteraction(request, config, adminInteraction);
  }
  const interaction = parseDiscordReservationInteraction(decoded.value);

  switch (interaction.kind) {
    case "ping": {
      const authorization = authorizeDiscordPingInteraction({ config, interaction });
      return authorization.kind === "authorized"
        ? NextResponse.json(buildDiscordPongResponse())
        : genericInteractionError(400);
    }
    case "component": {
      switch (interaction.command.kind) {
        case "accept":
          return deferInteraction(request, config, interaction);
        case "admin_cancel":
        case "no_show":
        case "reject":
          return respondToModalComponent(config, interaction);
        default:
          return assertNever(interaction.command.kind);
      }
    }
    case "modal_submit":
      return deferInteraction(request, config, interaction);
    case "invalid":
      return genericInteractionError(400);
    default:
      return assertNever(interaction);
  }
}

async function respondToAdminInteraction(
  request: Request,
  config: NonNullable<ReturnType<typeof parseDiscordApplicationConfig>>,
  interaction: Exclude<DiscordAdminInteraction, { readonly kind: "invalid" }>
): Promise<NextResponse> {
  const preparation = await waitForDiscordAdminPreparation({
    prepare: () => prepareDiscordAdminInteraction({
      config,
      interaction,
      ipHash: hashRequestClientIp(request),
      now: new Date()
    })
  });
  if (preparation.kind === "failed") {
    reportInteractionFailure("discord_admin_interaction_ack_failed", interaction.interactionId, preparation.error);
    return genericInteractionError(200);
  }
  if (preparation.kind === "timed_out") {
    after(() => completeLateDiscordAdminPreparation(config, interaction.interactionId, preparation.pending));
    return genericInteractionError(200);
  }
  return respondToPreparedAdminInteraction(config, interaction.interactionId, preparation.prepared);
}

function respondToPreparedAdminInteraction(
  config: NonNullable<ReturnType<typeof parseDiscordApplicationConfig>>,
  interactionId: string,
  prepared: PreparedDiscordAdminInteraction
): NextResponse {
  switch (prepared.kind) {
    case "rejected":
      return genericInteractionError(200);
    case "modal":
      return NextResponse.json(prepared.response);
    case "read":
    case "job":
    case "board":
      after(async () => {
        try {
          await completeDiscordAdminInteraction({ config, prepared });
        } catch (error) {
          reportInteractionFailure("discord_admin_interaction_completion_failed", interactionId, error);
        }
      });
      return NextResponse.json(prepared.kind === "board"
        ? buildDiscordDeferredPrivateResponse()
        : buildDiscordDeferredPublicResponse());
    default:
      return assertNever(prepared);
  }
}

async function completeLateDiscordAdminPreparation(
  config: NonNullable<ReturnType<typeof parseDiscordApplicationConfig>>,
  interactionId: string,
  pending: Promise<
    | { readonly kind: "failed"; readonly error: unknown }
    | { readonly kind: "prepared"; readonly prepared: PreparedDiscordAdminInteraction }
  >
): Promise<void> {
  const outcome = await pending;
  if (outcome.kind === "failed") {
    reportInteractionFailure("discord_admin_interaction_ack_failed", interactionId, outcome.error);
    return;
  }
  if (outcome.prepared.kind === "rejected" || outcome.prepared.kind === "modal") return;
  try {
    await completeDiscordAdminInteraction({ config, prepared: outcome.prepared });
  } catch (error) {
    reportInteractionFailure("discord_admin_interaction_completion_failed", interactionId, error);
  }
}

async function respondToModalComponent(
  config: NonNullable<ReturnType<typeof parseDiscordApplicationConfig>>,
  interaction: Extract<DiscordReservationInteraction, { readonly kind: "component" }>
): Promise<NextResponse> {
  const authorization = await authorizeDiscordInteractionModal({ config, interaction });
  return authorization.kind === "authorized"
    ? NextResponse.json(buildDiscordRejectReasonModal(interactionDataCustomId(interaction)))
    : genericInteractionError(200);
}

async function deferInteraction(
  request: Request,
  config: NonNullable<ReturnType<typeof parseDiscordApplicationConfig>>,
  interaction: Extract<DiscordReservationInteraction, { readonly kind: "component" | "modal_submit" }>
): Promise<NextResponse> {
  const ipHash = hashRequestClientIp(request);
  let acknowledgement: DiscordInteractionAcknowledgement;
  try {
    acknowledgement = await acknowledgeDiscordReservationInteraction({ config, interaction, ipHash });
  } catch (error) {
    console.error(JSON.stringify({
      errorType: error instanceof Error ? error.name : "UnknownError",
      event: "discord_interaction_acknowledgement_failed",
      interactionId: interaction.interactionId
    }));
    return genericInteractionError(200);
  }
  if (acknowledgement.kind !== "acknowledged") return genericInteractionError(200);
  after(async () => {
    try {
      await runExactPendingDiscordInteraction({
        applicationId: config.applicationId,
        botToken: config.botToken,
        interactionId: interaction.interactionId,
        interactionToken: interaction.interactionToken
      });
    } catch (error) {
      console.error(JSON.stringify({
        errorType: error instanceof Error ? error.name : "UnknownError",
        event: "discord_interaction_after_failed",
        interactionId: interaction.interactionId
      }));
    }
  });
  return NextResponse.json(buildDiscordDeferredEphemeralResponse());
}

function interactionDataCustomId(
  interaction: Extract<DiscordReservationInteraction, { readonly kind: "component" }>
): string {
  return interaction.command.sourceIdentity === undefined
    ? interaction.command.reservationId
    : buildSignedCustomIdFromRequest(interaction);
}

function buildSignedCustomIdFromRequest(
  interaction: Extract<DiscordReservationInteraction, { readonly kind: "component" }>
): string {
  const body = interaction.command;
  if (body.renderedEpoch === undefined || body.sourceIdentity === undefined) return body.reservationId;
  return buildDiscordReservationCustomId({
    action: body.kind,
    renderedEpoch: body.renderedEpoch,
    reservationId: body.reservationId,
    secret: process.env.DISCORD_BOT_TOKEN ?? "",
    sourceIdentity: body.sourceIdentity
  });
}

function readDiscordApplicationConfig(): NonNullable<ReturnType<typeof parseDiscordApplicationConfig>> | null {
  try {
    return parseDiscordApplicationConfig(process.env);
  } catch (error) {
    if (error instanceof DiscordApplicationConfigError) return null;
    throw error;
  }
}

function parseRawJson(body: Uint8Array):
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly value: unknown } {
  try {
    return { kind: "parsed", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return { kind: "malformed" };
    throw error;
  }
}

function genericInteractionError(status: number): NextResponse {
  return NextResponse.json(buildDiscordImmediateEphemeralErrorResponse(), { status });
}

function reportInteractionFailure(event: string, interactionId: string, error: unknown): void {
  console.error(JSON.stringify({
    errorType: error instanceof Error ? error.name : "UnknownError",
    event,
    interactionId
  }));
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Discord interaction: ${JSON.stringify(value)}`);
}
