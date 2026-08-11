import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { DiscordBotClient, DiscordBotDeliveryResult } from "./discord-bot";
import type { DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";
import { ServerEnvError } from "./env";
import { defaultNotificationSettings } from "./notification-settings";
import {
  createDiscordReservationOutbox,
  type DiscordReservationOutboxDependencies
} from "./discord-reservation-outbox";

const now = new Date("2026-08-11T00:00:00.000Z");
const claim = { attempts: 1, claimId: "claim-1", nonce: "reservation-abc", outcome: null, reservationId: "reservation-1" };
type OutboxRepository = DiscordReservationOutboxDependencies["repository"];
type MockOutboxRepository = { readonly [TKey in keyof OutboxRepository]: Mock<OutboxRepository[TKey]> };

describe("Discord reservation outbox", () => {
  let dependencies: ReturnType<typeof dependenciesFixture>;

  beforeEach(() => {
    dependencies = dependenciesFixture();
  });

  it("persists a terminal disabled outcome without network delivery", async () => {
    dependencies.getNotificationSettings.mockResolvedValue(defaultNotificationSettings());

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ claimed: 1, terminal: 1 });
    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
    expect(dependencies.sendWebhook).not.toHaveBeenCalled();
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "SKIPPED_DISABLED",
      retryable: false
    }));
  });

  it("uses the existing webhook payload in webhook-only mode and finishes once", async () => {
    dependencies.getApplicationConfig.mockReturnValue(null);
    dependencies.sendWebhook.mockResolvedValue({ kind: "sent", messageIds: ["webhook-message"] });

    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.sendWebhook).toHaveBeenCalledWith(expect.objectContaining({
      applicant: expect.objectContaining({ name: "김학생", studentNumber: "20261234" }),
      reservation: expect.objectContaining({ id: claim.reservationId })
    }));
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "WEBHOOK_SENT",
      retryable: false
    }));
  });

  it("persists bot message identity and sync state after interactive delivery", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue({ kind: "sent", messageId: "bot-message" });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ claimed: 1, sent: 1 });
    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "12345678901234567",
      payload: expect.objectContaining({ components: expect.any(Array) }),
      reservationId: claim.reservationId
    }));
    expect(dependencies.repository.saveInitialSendSuccess).toHaveBeenCalledWith({
      channelId: "12345678901234567",
      claimId: claim.claimId,
      guildId: "22345678901234567",
      messageId: "bot-message",
      reservationId: claim.reservationId,
      sentAt: now
    });
  });

  it("retries UNKNOWN bot delivery without webhook fallback", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue({
      code: "discord_timeout",
      kind: "unknown",
      message: "timeout",
      outcome: "UNKNOWN"
    });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ retried: 1 });
    expect(dependencies.sendWebhook).not.toHaveBeenCalled();
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "UNKNOWN",
      retryable: true
    }));
  });

  it("performs exactly one webhook fallback after a definite bot failure", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue(botFailure());
    dependencies.sendWebhook.mockResolvedValue({ kind: "sent", messageIds: ["fallback-message"] });

    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "WEBHOOK_FALLBACK_SENT",
      retryable: false
    }));
  });

  it("does not repeat a webhook fallback recovered after its durable start marker", async () => {
    dependencies.repository.claimInitialSend.mockResolvedValue({
      ...claim,
      attempts: 2,
      outcome: "WEBHOOK_FALLBACK_STARTED"
    });

    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
    expect(dependencies.sendWebhook).not.toHaveBeenCalled();
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "WEBHOOK_FALLBACK_INTERRUPTED",
      retryable: false
    }));
  });

  it("keeps a successful webhook terminal when the terminal database save throws", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue(botFailure());
    dependencies.repository.saveInitialSendFailure.mockRejectedValueOnce(new Error("terminal save unavailable"));
    dependencies.repository.claimInitialSend
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({ ...claim, attempts: 2, outcome: "WEBHOOK_FALLBACK_STARTED" });

    const first = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });
    const second = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(first.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(second.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveInitialSendFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true })
    );
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "WEBHOOK_FALLBACK_INTERRUPTED", retryable: false })
    );
  });

  it("terminalizes an unexpected sender throw without reopening webhook retry", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue(botFailure());
    dependencies.sendWebhook.mockRejectedValueOnce(new Error("unexpected sender failure"));
    dependencies.repository.claimInitialSend
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({ ...claim, attempts: 2, outcome: "WEBHOOK_FALLBACK_STARTED" });

    const first = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });
    const second = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(first.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(second.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveInitialSendFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true })
    );
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "WEBHOOK_FALLBACK_INTERRUPTED", retryable: false })
    );
  });

  it("performs one terminal webhook fallback for a definite application config failure", async () => {
    dependencies.getApplicationConfig.mockImplementation(() => {
      throw new ServerEnvError(["DISCORD_BOT_TOKEN"]);
    });

    await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "WEBHOOK_FALLBACK_SENT",
      retryable: false
    }));
  });

  it("prioritizes a single immediate reservation claim", async () => {
    await createDiscordReservationOutbox(dependencies)({ now, reservationId: "reservation-priority" });

    expect(dependencies.repository.claimInitialSend).toHaveBeenCalledWith(now, "reservation-priority");
    expect(dependencies.repository.claimMessageSync).toHaveBeenCalledWith(now, "reservation-priority");
    expect(dependencies.repository.claimInitialSends).not.toHaveBeenCalled();
    expect(dependencies.repository.claimMessageSyncs).not.toHaveBeenCalled();
  });

  it("handles eligible initial and source-sync claims in one reservation-scoped run", async () => {
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({ cancellationReason: null, decision: "ACCEPTED" });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ claimed: 1, sent: 1 });
    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("runs an interaction-style terminal source sync immediately by reservation id", async () => {
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSync.mockResolvedValue(syncClaim());
    dependencies.repository.readMessageSyncState.mockResolvedValue({
      cancellationReason: "상호작용 거절",
      decision: "CANCELLED"
    });
    dependencies.loadSnapshot.mockResolvedValue(snapshot("CANCELLED"));

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.repository.claimMessageSync).toHaveBeenCalledWith(now, claim.reservationId);
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ components: [] })
    }));
  });

  it("syncs a newer cancelled source state without controls and uses the existing admin reason", async () => {
    dependencies.repository.claimInitialSend.mockResolvedValue(null);
    dependencies.repository.claimMessageSyncs.mockResolvedValue([{
      attempts: 1,
      channelId: "channel",
      claimId: "sync-claim",
      guildId: "guild",
      messageId: "message",
      reservationId: claim.reservationId,
      revision: 2
    }]);
    dependencies.repository.readMessageSyncState.mockResolvedValue({
      cancellationReason: "관리자 취소 사유",
      decision: "ACCEPTED"
    });
    dependencies.loadSnapshot.mockResolvedValue(snapshot("CANCELLED"));
    dependencies.bot.editChannelMessage.mockResolvedValue({ kind: "sent", messageId: "message" });

    const result = await createDiscordReservationOutbox(dependencies)({ now });

    expect(result.sync).toMatchObject({ claimed: 1, synced: 1 });
    expect(dependencies.bot.editChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ components: [] })
    }));
    expect(JSON.stringify(dependencies.bot.editChannelMessage.mock.calls[0]?.[0])).toContain("관리자 취소 사유");
  });
});

function dependenciesFixture() {
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
    beginInitialSendTerminalDelivery: vi.fn<DiscordReservationOutboxDependencies["repository"]["beginInitialSendTerminalDelivery"]>(),
    claimInitialSend: vi.fn<DiscordReservationOutboxDependencies["repository"]["claimInitialSend"]>(),
    claimInitialSends: vi.fn<DiscordReservationOutboxDependencies["repository"]["claimInitialSends"]>(),
    claimMessageSync: vi.fn<DiscordReservationOutboxDependencies["repository"]["claimMessageSync"]>(),
    claimMessageSyncs: vi.fn<DiscordReservationOutboxDependencies["repository"]["claimMessageSyncs"]>(),
    readMessageSyncState: vi.fn<DiscordReservationOutboxDependencies["repository"]["readMessageSyncState"]>(),
    saveInitialSendFailure: vi.fn<DiscordReservationOutboxDependencies["repository"]["saveInitialSendFailure"]>(),
    saveInitialSendSuccess: vi.fn<DiscordReservationOutboxDependencies["repository"]["saveInitialSendSuccess"]>(),
    saveSyncFailure: vi.fn<DiscordReservationOutboxDependencies["repository"]["saveSyncFailure"]>(),
    saveSyncSuccess: vi.fn<DiscordReservationOutboxDependencies["repository"]["saveSyncSuccess"]>()
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

function syncClaim() {
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

function snapshot(status: "CANCELLED" | "CONFIRMED" | "NO_SHOW"): DiscordReservationSnapshotResult {
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

function botFailure(): DiscordBotDeliveryResult {
  return { code: "discord_http_403", kind: "failed", message: "forbidden", outcome: "FAILED" };
}
