import type { DiscordApplicationConfig } from "./discord-app-config";
import { createDiscordBotClient } from "./discord-bot";
import { dispatchDiscordAdminCommand, executeDiscordAdminReadCommand } from "./discord-admin-command-executor";
import { runDiscordAdminCommandJobs } from "./discord-admin-command-runner";
import {
  buildDiscordAdminResultPayload,
  discordAdminFailureResult,
  discordAdminSuccessResult
} from "./discord-admin-command-results";
import { deliverPendingDiscordAdminResults } from "./discord-admin-result-delivery";
import type { PreparedDiscordAdminInteraction } from "./discord-admin-interaction-ack";
import { syncDiscordOperationsBoard } from "./discord-operations-board-service";
import {
  claimExactDiscordAdminResultDelivery,
  completeDiscordAdminResultDelivery,
  failDiscordAdminResultDelivery
} from "./prisma-discord-admin-result-delivery";
import { prismaDiscordAdminCommandJobStore } from "./prisma-discord-admin-command-runner-store";
import { requestDiscordOperationsBoardSync } from "./prisma-discord-operations-board";
import { toKstDate } from "./date";

type PreparedCompletion = Extract<PreparedDiscordAdminInteraction, { readonly kind: "board" | "job" | "read" }>;

export async function completeDiscordAdminInteraction(input: {
  readonly config: DiscordApplicationConfig;
  readonly prepared: PreparedCompletion;
}): Promise<void> {
  switch (input.prepared.kind) {
    case "read":
      await completeRead(input.config, input.prepared);
      break;
    case "job":
      await completeJob(input.config, input.prepared);
      break;
    case "board":
      await completeBoardAction(input.config, input.prepared);
      break;
    default:
      assertNever(input.prepared);
  }
}

export async function runDiscordAdminCommandCronWorker(input: {
  readonly config: DiscordApplicationConfig;
  readonly now: Date;
}) {
  const bot = createDiscordBotClient({ applicationId: input.config.applicationId, botToken: input.config.botToken });
  const commands = await runDiscordAdminCommandJobs({
    dispatch: (claim) => dispatchDiscordAdminCommand({ claim, config: input.config, now: input.now }),
    now: input.now,
    store: prismaDiscordAdminCommandJobStore
  });
  await requestDiscordOperationsBoardSync(input.now);
  const deliveries = await deliverPendingDiscordAdminResults({ bot, now: input.now });
  const board = await syncDiscordOperationsBoard({ config: input.config, now: input.now });
  return { board, commands, deliveries };
}

async function completeRead(
  config: DiscordApplicationConfig,
  prepared: Extract<PreparedCompletion, { readonly kind: "read" }>
): Promise<void> {
  const bot = createDiscordBotClient({ applicationId: config.applicationId, botToken: config.botToken });
  const result = await executeDiscordAdminReadCommand({
    actor: prepared.actor,
    intent: prepared.intent,
    now: new Date(),
    secret: config.botToken
  });
  await bot.editOriginalEphemeralResponse({
    interactionToken: prepared.interactionToken,
    payload: buildDiscordAdminResultPayload(result)
  });
}

async function completeJob(
  config: DiscordApplicationConfig,
  prepared: Extract<PreparedCompletion, { readonly kind: "job" }>
): Promise<void> {
  await runDiscordAdminCommandJobs({
    dispatch: (claim) => dispatchDiscordAdminCommand({ claim, config, now: new Date() }),
    executionInteractionId: prepared.executionInteractionId,
    now: new Date(),
    store: prismaDiscordAdminCommandJobStore
  });
  const now = new Date();
  const claim = await claimExactDiscordAdminResultDelivery({
    executionInteractionId: prepared.executionInteractionId,
    now
  });
  if (claim !== null) {
    const delivery = await createDiscordBotClient({
      applicationId: config.applicationId,
      botToken: config.botToken
    }).editOriginalEphemeralResponse({
      interactionToken: prepared.interactionToken,
      payload: buildDiscordAdminResultPayload(claim.result)
    });
    if (delivery.kind === "sent") {
      await completeDiscordAdminResultDelivery({ claim, messageId: delivery.messageId });
    } else {
      await failDiscordAdminResultDelivery({ claim, errorCode: delivery.code, now });
    }
  }
  await requestDiscordOperationsBoardSync(now);
  await syncDiscordOperationsBoard({ config, force: true, now });
}

async function completeBoardAction(
  config: DiscordApplicationConfig,
  prepared: Extract<PreparedCompletion, { readonly kind: "board" }>
): Promise<void> {
  const bot = createDiscordBotClient({ applicationId: config.applicationId, botToken: config.botToken });
  if (prepared.action === "refresh") {
    const now = new Date();
    await requestDiscordOperationsBoardSync(now);
    const sync = await syncDiscordOperationsBoard({ config, force: true, now });
    await bot.editOriginalEphemeralResponse({
      interactionToken: prepared.interactionToken,
      payload: buildDiscordAdminResultPayload(sync.kind === "failed"
        ? discordAdminFailureResult({ description: "운영판을 갱신하지 못했습니다.", title: "갱신 실패" })
        : discordAdminSuccessResult({ description: "운영판을 최신 상태로 갱신했습니다.", title: "갱신 완료" }))
    });
    return;
  }
  const date = toKstDate(new Date());
  const intent = prepared.action === "backlog"
    ? { kind: "operations_backlog" as const }
    : { date, kind: "roster" as const, studyPeriod: prepared.action === "roster_eighth" ? "EIGHTH" as const : "FIRST" as const };
  const result = await executeDiscordAdminReadCommand({
    actor: prepared.actor,
    intent,
    now: new Date(),
    secret: config.botToken
  });
  const delivery = await bot.createChannelMessage({
    channelId: config.channelId,
    payload: buildDiscordAdminResultPayload(result),
    reservationId: `board-action-${prepared.interactionId}`
  });
  await bot.editOriginalEphemeralResponse({
    interactionToken: prepared.interactionToken,
    payload: buildDiscordAdminResultPayload(delivery.kind === "sent"
      ? discordAdminSuccessResult({ description: "운영 채널에 결과를 게시했습니다.", title: "게시 완료" })
      : discordAdminFailureResult({ description: "결과를 게시하지 못했습니다.", title: "게시 실패" }))
  });
}

function assertNever(value: never): never {
  throw new DiscordAdminCompletionVariantError(JSON.stringify(value));
}

class DiscordAdminCompletionVariantError extends Error {
  public override readonly name = "DiscordAdminCompletionVariantError";
}
