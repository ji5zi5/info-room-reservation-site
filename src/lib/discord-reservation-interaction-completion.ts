import type {
  DiscordBotDeliveryResult,
  DiscordBotMessagePayload
} from "./discord-bot";
import { operationFromDiscordInteractionClaim } from "./discord-interaction-job-contract";
import {
  runDiscordInteractionJobs,
  type DiscordInteractionDispatchResult
} from "./discord-interaction-job-runner";
import type { DiscordReservationOperationCommand } from "./discord-reservation-operations";
import { prismaDiscordInteractionJobStore } from "./prisma-discord-interaction-job-store";

export type DiscordInteractionCompletionDependencies = {
  readonly dispatch: (input: {
    readonly command: DiscordReservationOperationCommand;
    readonly ipHash: string;
    readonly now: Date;
  }) => Promise<DiscordInteractionDispatchResult>;
  readonly editCompletion: (input: {
    readonly applicationId: string;
    readonly botToken: string;
    readonly interactionToken: string;
    readonly payload: DiscordBotMessagePayload;
  }) => Promise<DiscordBotDeliveryResult>;
  readonly runJobs: typeof runDiscordInteractionJobs;
};

export async function runExactDiscordReservationInteraction(
  dependencies: DiscordInteractionCompletionDependencies,
  input: {
    readonly applicationId: string;
    readonly botToken: string;
    readonly interactionId: string;
    readonly interactionToken: string;
  }
): Promise<void> {
  let completion: DiscordInteractionDispatchResult | null = null;
  const result = await dependencies.runJobs({
    dispatch: async (claim) => {
      const operation = operationFromDiscordInteractionClaim(claim);
      const outcome = operation === null
        ? { errorCode: "persisted_command_invalid", errorType: "INTEGRITY", kind: "terminal_failure" } as const
        : await dependencies.dispatch({ command: operation, ipHash: claim.ipHash, now: new Date() });
      completion = outcome;
      return outcome;
    },
    interactionId: input.interactionId,
    now: new Date(),
    store: prismaDiscordInteractionJobStore
  });
  if (result.claimed !== 1) return;
  await editCompletionBestEffort(dependencies, input, completionPayload(completion));
}

function completionPayload(result: DiscordInteractionDispatchResult | null): DiscordBotMessagePayload {
  if (result?.kind === "succeeded") return embedPayload(0x57f287, "처리 완료", "요청을 처리했습니다.");
  if (result?.kind === "stale") return embedPayload(0xfee75c, "처리 결과", "이미 처리되었거나 만료된 요청입니다.");
  return embedPayload(0xed4245, "처리 실패", "요청을 처리할 수 없습니다.");
}

async function editCompletionBestEffort(
  dependencies: DiscordInteractionCompletionDependencies,
  input: { readonly applicationId: string; readonly botToken: string; readonly interactionId: string; readonly interactionToken: string },
  payload: DiscordBotMessagePayload
): Promise<void> {
  try {
    const result = await dependencies.editCompletion({
      applicationId: input.applicationId,
      botToken: input.botToken,
      interactionToken: input.interactionToken,
      payload
    });
    if (result.kind !== "sent") {
      console.error(JSON.stringify({
        code: result.code,
        event: "discord_interaction_ephemeral_completion_failed",
        interactionId: input.interactionId,
        outcome: result.outcome
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      errorType: error instanceof Error ? error.name : "UnknownError",
      event: "discord_interaction_ephemeral_completion_failed",
      interactionId: input.interactionId
    }));
  }
}

function embedPayload(color: number, title: string, description: string): DiscordBotMessagePayload {
  return { allowed_mentions: { parse: [] }, embeds: [{ color, description, fields: [], title }] };
}
