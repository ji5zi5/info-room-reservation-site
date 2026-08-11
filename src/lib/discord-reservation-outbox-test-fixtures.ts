import { vi, type Mock } from "vitest";

import type { DiscordBotClient, DiscordBotDeliveryResult } from "./discord-bot";
import type { DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";
import { defaultNotificationSettings } from "./notification-settings";
import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox";

export const now = new Date("2026-08-11T00:00:00.000Z");
export const claim = {
  attempts: 1,
  claimId: "claim-1",
  nonce: "reservation-abc",
  outcome: null,
  reservationId: "reservation-1"
};

type OutboxRepository = DiscordReservationOutboxDependencies["repository"];
type MockOutboxRepository = { readonly [TKey in keyof OutboxRepository]: Mock<OutboxRepository[TKey]> };

export function dependenciesFixture() {
  const bot = {
    createChannelMessage: vi.fn<DiscordBotClient["createChannelMessage"]>(),
    deleteChannelMessage: vi.fn<DiscordBotClient["deleteChannelMessage"]>(),
    editChannelMessage: vi.fn<DiscordBotClient["editChannelMessage"]>(),
    editOriginalEphemeralResponse: vi.fn<DiscordBotClient["editOriginalEphemeralResponse"]>()
  };
  bot.createChannelMessage.mockResolvedValue({ kind: "sent", messageId: "bot-message" });
  bot.deleteChannelMessage.mockResolvedValue({ kind: "removed" });
  bot.editChannelMessage.mockResolvedValue({ kind: "sent", messageId: "bot-message" });
  const getApplicationConfig = vi.fn<DiscordReservationOutboxDependencies["getApplicationConfig"]>();
  getApplicationConfig.mockReturnValue({
    adminRoleId: "32345678901234567",
    adminUserBindings: [{ discordUserId: "42345678901234567", studentNumber: "31001" }],
    applicationId: "52345678901234567",
    botToken: "token",
    channelId: "12345678901234567",
    guildId: "22345678901234567",
    publicKey: "a".repeat(64)
  });
  const getNotificationSettings = vi.fn<DiscordReservationOutboxDependencies["getNotificationSettings"]>();
  getNotificationSettings.mockResolvedValue({
    ...defaultNotificationSettings(),
    reservationCreatedNotificationsEnabled: true
  });
  const loadSnapshot = vi.fn<(reservationId: string) => Promise<DiscordReservationSnapshotResult>>();
  loadSnapshot.mockResolvedValue(snapshot("CONFIRMED"));
  const sendWebhook = vi.fn<DiscordReservationOutboxDependencies["sendWebhook"]>();
  sendWebhook.mockResolvedValue({ kind: "sent", messageIds: ["webhook-message"] });
  const repository: MockOutboxRepository = {
    beginInitialSendTerminalDelivery: vi.fn<OutboxRepository["beginInitialSendTerminalDelivery"]>(),
    claimInitialSend: vi.fn<OutboxRepository["claimInitialSend"]>(),
    claimInitialSends: vi.fn<OutboxRepository["claimInitialSends"]>(),
    claimMessageSync: vi.fn<OutboxRepository["claimMessageSync"]>(),
    claimMessageSyncs: vi.fn<OutboxRepository["claimMessageSyncs"]>(),
    readMessageSyncState: vi.fn<OutboxRepository["readMessageSyncState"]>(),
    saveInitialSendFailure: vi.fn<OutboxRepository["saveInitialSendFailure"]>(),
    saveInitialSendSuccess: vi.fn<OutboxRepository["saveInitialSendSuccess"]>(),
    saveSyncFailure: vi.fn<OutboxRepository["saveSyncFailure"]>(),
    saveSyncSuccess: vi.fn<OutboxRepository["saveSyncSuccess"]>()
  };
  repository.beginInitialSendTerminalDelivery.mockResolvedValue(true);
  repository.claimInitialSend.mockResolvedValue(claim);
  repository.claimInitialSends.mockResolvedValue([]);
  repository.claimMessageSync.mockResolvedValue(null);
  repository.claimMessageSyncs.mockResolvedValue([]);
  repository.readMessageSyncState.mockResolvedValue({ cancellationReason: null, decision: null });
  repository.saveInitialSendFailure.mockResolvedValue(true);
  repository.saveInitialSendSuccess.mockResolvedValue(true);
  repository.saveSyncFailure.mockResolvedValue(true);
  repository.saveSyncSuccess.mockResolvedValue(true);
  return {
    bot,
    getApplicationConfig,
    getNotificationSettings,
    getWebhookUrl: vi.fn(() => "https://discord.com/api/webhooks/1/token"),
    loadSnapshot,
    repository,
    sendWebhook
  } satisfies DiscordReservationOutboxDependencies;
}

export function syncClaim() {
  return {
    attempts: 1,
    channelId: "channel",
    claimId: "sync-claim",
    guildId: "guild",
    messageId: "message",
    reservationId: claim.reservationId,
    revision: 2
  } as const;
}

export function snapshot(status: "CANCELLED" | "CONFIRMED" | "NO_SHOW"): DiscordReservationSnapshotResult {
  const value = {
    capacity: 10,
    closeAtUnix: 1_781_679_000,
    confirmedCount: 9,
    effectiveSetting: {
      capacity: 10,
      closeTime: "15:50",
      date: "2026-08-11",
      enabled: true,
      openTime: "13:00",
      studyPeriod: "EIGHTH" as const
    },
    remaining: 1,
    reservation: {
      date: "2026-08-11",
      id: claim.reservationId,
      reason: "과제",
      status,
      studyPeriod: "EIGHTH" as const,
      user: { id: "student-1", name: "김학생", studentNumber: "20261234" },
      userId: "student-1"
    }
  };
  return status === "CONFIRMED" ? { kind: "ready", snapshot: value } : { kind: "stale", snapshot: value };
}

export function botFailure(): DiscordBotDeliveryResult {
  return { code: "discord_http_403", kind: "failed", message: "forbidden", outcome: "FAILED" };
}
