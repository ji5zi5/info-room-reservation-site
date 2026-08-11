import { createDiscordBotClient, type DiscordBotDeliveryResult, type DiscordBotMessagePayload } from "./discord-bot";
import type { DiscordApplicationConfig } from "./discord-app-config";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import {
  processDiscordReservationDecision,
  type DiscordReservationDecisionResult
} from "./discord-reservation-operations";
import { runDiscordReservationOutbox } from "./discord-reservation-outbox";
import {
  authorizeDiscordReservationInteraction,
  type DiscordReservationInteraction,
  type DiscordReservationInteractionCommand,
  type DiscordReservationMessageLedgerSnapshot
} from "./discord-interactions";

type ActionInteraction = Extract<DiscordReservationInteraction, { readonly kind: "component" | "modal_submit" }>;
type DecisionCommand = Extract<DiscordReservationInteractionCommand, { readonly kind: "accept" | "reject" }>;

type HandlerDependencies = {
  readonly editCompletion: (input: {
    readonly applicationId: string;
    readonly botToken: string;
    readonly interactionToken: string;
    readonly payload: DiscordBotMessagePayload;
  }) => Promise<DiscordBotDeliveryResult>;
  readonly loadLedger: (messageId: string) => Promise<DiscordReservationMessageLedgerSnapshot | null>;
  readonly processDecision: (input: {
    readonly command: DecisionCommand;
    readonly ipHash: string;
    readonly now: Date;
  }) => Promise<DiscordReservationDecisionResult>;
  readonly runOutbox: typeof runDiscordReservationOutbox;
};

type DeferredInput = {
  readonly config: DiscordApplicationConfig;
  readonly interaction: ActionInteraction;
  readonly ipHash: string;
};

export type RejectComponentAuthorization =
  | { readonly kind: "authorized"; readonly reservationId: string }
  | { readonly kind: "rejected" };

export function createDiscordInteractionHandler(dependencies: HandlerDependencies) {
  return {
    authorizeRejectComponent: async (input: {
      readonly config: DiscordApplicationConfig;
      readonly interaction: Extract<ActionInteraction, { readonly kind: "component" }>;
    }): Promise<RejectComponentAuthorization> => {
      const authorization = await authorizeAgainstSource(dependencies, input);
      return authorization?.command.kind === "open_reject_modal"
        ? { kind: "authorized", reservationId: authorization.command.reservationId }
        : { kind: "rejected" };
    },
    runDeferred: async (input: DeferredInput): Promise<void> => {
      let payload = genericCompletionPayload();
      try {
        const authorization = await authorizeAgainstSource(dependencies, input);
        if (authorization !== null && authorization.command.kind !== "open_reject_modal") {
          const result = await dependencies.processDecision({
            command: authorization.command,
            ipHash: input.ipHash,
            now: new Date()
          });
          try {
            await dependencies.runOutbox({ now: new Date(), reservationId: authorization.command.reservationId });
          } catch (error) {
            reportDeferredFailure("discord_interaction_outbox_failed", input.interaction.interactionId, error);
          }
          payload = completionPayload(result);
        }
      } catch (error) {
        reportDeferredFailure("discord_interaction_processing_failed", input.interaction.interactionId, error);
      }
      await editCompletionBestEffort(dependencies, input, payload);
    }
  } as const;
}

const defaultHandler = createDiscordInteractionHandler({
  editCompletion: async ({ applicationId, botToken, interactionToken, payload }) =>
    createDiscordBotClient({ applicationId, botToken }).editOriginalEphemeralResponse({ interactionToken, payload }),
  loadLedger: (messageId) =>
    withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: async (transaction) => {
        const ledger = await transaction.discordReservationMessage.findUnique({
          select: { messageId: true, reservationId: true },
          where: { messageId }
        });
        return ledger === null || ledger.messageId === null
          ? null
          : { messageId: ledger.messageId, reservationId: ledger.reservationId };
      }
    }),
  processDecision: processDiscordReservationDecision,
  runOutbox: runDiscordReservationOutbox
});

export const authorizeRejectComponent = defaultHandler.authorizeRejectComponent;
export const runDeferredDiscordReservationInteraction = defaultHandler.runDeferred;

async function authorizeAgainstSource(
  dependencies: HandlerDependencies,
  input: { readonly config: DiscordApplicationConfig; readonly interaction: ActionInteraction }
): Promise<{ readonly command: DiscordReservationInteractionCommand } | null> {
  const ledger = await dependencies.loadLedger(input.interaction.messageId);
  if (ledger === null) return null;
  const authorization = authorizeDiscordReservationInteraction({ config: input.config, interaction: input.interaction, ledger });
  return authorization.kind === "authorized" ? authorization : null;
}

async function editCompletionBestEffort(
  dependencies: HandlerDependencies,
  input: DeferredInput,
  payload: DiscordBotMessagePayload
): Promise<void> {
  try {
    const result = await dependencies.editCompletion({
      applicationId: input.config.applicationId,
      botToken: input.config.botToken,
      interactionToken: input.interaction.interactionToken,
      payload
    });
    if (result.kind !== "sent") {
      console.error(JSON.stringify({
        code: result.code,
        event: "discord_interaction_ephemeral_completion_failed",
        interactionId: input.interaction.interactionId,
        outcome: result.outcome
      }));
    }
  } catch (error) {
    reportDeferredFailure("discord_interaction_ephemeral_completion_failed", input.interaction.interactionId, error);
  }
}

function completionPayload(result: DiscordReservationDecisionResult): DiscordBotMessagePayload {
  switch (result.kind) {
    case "accepted":
      return embedPayload(0x57f287, "예약 수락 완료", "예약을 수락했습니다.");
    case "cancelled":
      return embedPayload(0xed4245, "예약 거절 완료", "예약을 거절했습니다.");
    case "noop":
    case "stale":
      return genericCompletionPayload();
    default:
      return assertNever(result);
  }
}

function genericCompletionPayload(): DiscordBotMessagePayload {
  return embedPayload(0xfee75c, "처리 결과", "요청을 처리할 수 없습니다.");
}

function embedPayload(color: number, title: string, description: string): DiscordBotMessagePayload {
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ color, description, fields: [], title }]
  };
}

function reportDeferredFailure(event: string, interactionId: string, error: unknown): void {
  console.error(JSON.stringify({
    errorType: error instanceof Error ? error.name : "UnknownError",
    event,
    interactionId
  }));
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected Discord decision result: ${JSON.stringify(value)}`);
}
