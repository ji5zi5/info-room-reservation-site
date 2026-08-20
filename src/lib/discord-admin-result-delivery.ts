import type { DiscordBotClient } from "./discord-bot";
import { buildDiscordAdminResultPayload } from "./discord-admin-command-results";
import {
  claimDiscordAdminResultDeliveries,
  completeDiscordAdminResultDelivery,
  failDiscordAdminResultDelivery
} from "./prisma-discord-admin-result-delivery";

export type DiscordAdminResultDeliverySummary = {
  readonly failed: number;
  readonly sent: number;
};

export async function deliverPendingDiscordAdminResults(input: {
  readonly bot: Pick<DiscordBotClient, "createChannelMessage">;
  readonly now: Date;
}): Promise<DiscordAdminResultDeliverySummary> {
  const claims = await claimDiscordAdminResultDeliveries(input.now);
  const summary = { failed: 0, sent: 0 };
  for (const claim of claims) {
    const delivery = await input.bot.createChannelMessage({
      channelId: claim.channelId,
      payload: buildDiscordAdminResultPayload(claim.result),
      reservationId: `admin-command-${claim.id}`
    });
    if (delivery.kind === "sent") {
      await completeDiscordAdminResultDelivery({ claim, messageId: delivery.messageId });
      summary.sent += 1;
    } else {
      await failDiscordAdminResultDelivery({ claim, errorCode: delivery.code, now: input.now });
      summary.failed += 1;
    }
  }
  return summary;
}
