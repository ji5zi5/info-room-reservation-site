import { after, NextResponse } from "next/server";

import { DiscordApplicationConfigError, parseDiscordApplicationConfig } from "@/lib/discord-app-config";
import {
  acknowledgeDiscordReservationInteraction,
  authorizeDiscordInteractionModal,
  runExactPendingDiscordInteraction
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
  const acknowledgement = await acknowledgeDiscordReservationInteraction({ config, interaction, ipHash });
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

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Discord interaction: ${JSON.stringify(value)}`);
}
