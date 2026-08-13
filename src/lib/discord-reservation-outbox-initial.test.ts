import { describe, expect, it, vi } from "vitest";

import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";
import type { DiscordBotClient, DiscordBotDeliveryResult } from "./discord-bot";
import type { DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";
import { parseDiscordReservationInteraction } from "./discord-interactions";
import { createDiscordReservationOutbox } from "./discord-reservation-outbox";
import {
  processDiscordInitialClaim,
  reconcileExpiredDiscordInitialPosts
} from "./discord-reservation-outbox-initial";

const now = new Date("2026-08-11T00:00:00.000Z");
const claim = {
  attempts: 1,
  claimId: "claim-1",
  nonce: "reservation-nonce",
  outcome: null,
  reservationId: "reservation-1"
} as const;

describe("Discord reservation initial POST", () => {
  it("signs initial controls with the current fenced epoch and configured bot token", async () => {
    const configuredBotToken = "initial-control-config-token";
    const dependencies = readyDependencies({ botToken: configuredBotToken, controlEpoch: 7 });
    vi.stubEnv("DISCORD_BOT_TOKEN", "ambient-token-that-must-not-verify");

    try {
      await expect(processDiscordInitialClaim(dependencies, claim, now)).resolves.toBe("sent");

      expectInitialControlCommands(dependencies, configuredBotToken, 7);
      expect(dependencies.repository.saveInitialSendSuccess).toHaveBeenCalledWith({
        channelId: "channel",
        claimId: "claim-1",
        guildId: "guild",
        messageId: "message-1",
        renderedSourceEpoch: 7,
        reservationId: "reservation-1",
        sentAt: now
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("re-renders initial controls with the changed epoch after operations re-enable", async () => {
    const configuredBotToken = "re-enabled-control-config-token";
    const dependencies = readyDependencies({ botToken: configuredBotToken, controlEpoch: 8 });

    await expect(processDiscordInitialClaim(dependencies, claim, now)).resolves.toBe("sent");

    expectInitialControlCommands(dependencies, configuredBotToken, 8);
  });

  it("performs zero HTTP requests when CLAIMED cannot transition to POSTING", async () => {
    const dependencies = readyDependencies({ posting: false });

    await expect(processDiscordInitialClaim(dependencies, claim, now)).resolves.toBe("review");

    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
    expect(dependencies.repository.markInitialSendPendingReview).toHaveBeenCalledWith({
      claimId: "claim-1",
      reason: "POSTING_CAS_REJECTED",
      reservationId: "reservation-1"
    });
  });

  it("performs one HTTP request after POSTING and leaves an unknown result in review", async () => {
    const dependencies = readyDependencies({
      delivery: {
        code: "discord_network_error",
        kind: "unknown",
        message: "response lost",
        outcome: "UNKNOWN"
      }
    });

    await expect(processDiscordInitialClaim(dependencies, claim, now)).resolves.toBe("review");

    expect(dependencies.repository.beginInitialSendPost).toHaveBeenCalledOnce();
    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledOnce();
    expect(dependencies.repository.saveInitialSendFailure).not.toHaveBeenCalled();
    expect(dependencies.repository.markInitialSendPendingReview).toHaveBeenCalledWith({
      claimId: "claim-1",
      reason: "UNKNOWN",
      reservationId: "reservation-1"
    });
  });

  it("moves a returned POST to review when success persistence fails", async () => {
    const dependencies = readyDependencies({ saveSuccess: false });

    await expect(processDiscordInitialClaim(dependencies, claim, now)).resolves.toBe("review");

    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledOnce();
    expect(dependencies.repository.markInitialSendPendingReview).toHaveBeenCalledWith({
      claimId: "claim-1",
      reason: "RESULT_PERSISTENCE_FAILED",
      reservationId: "reservation-1"
    });
  });

  it("retries only an explicit non-accepting response after one POST", async () => {
    const dependencies = readyDependencies({
      delivery: {
        code: "discord_http_403",
        kind: "failed",
        message: "forbidden",
        outcome: "FAILED"
      }
    });

    await expect(processDiscordInitialClaim(dependencies, claim, now)).resolves.toBe("retried");

    expect(dependencies.bot.createChannelMessage).toHaveBeenCalledOnce();
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "FAILED", retryable: true })
    );
    expect(dependencies.repository.markInitialSendPendingReview).not.toHaveBeenCalled();
  });

  it("moves expired POSTING work to review without issuing another POST", async () => {
    const dependencies = readyDependencies({ expiredPostingCount: 2 });

    await expect(reconcileExpiredDiscordInitialPosts(dependencies, now)).resolves.toBe(2);

    expect(dependencies.repository.reconcileExpiredInitialPosts).toHaveBeenCalledWith(now);
    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
  });

  it("reports review outcomes explicitly in the initial run summary", async () => {
    const dependencies = readyDependencies({
      delivery: {
        code: "discord_network_error",
        kind: "unknown",
        message: "response lost",
        outcome: "UNKNOWN"
      },
      initialClaims: [claim]
    });

    const result = await createDiscordReservationOutbox(dependencies)({ now });

    expect(result.initial).toEqual({
      claimed: 1,
      retried: 0,
      review: 1,
      sent: 0,
      terminal: 0
    });
  });
});

function readyDependencies(input: Readonly<{
  botToken?: string;
  controlEpoch?: number;
  delivery?: DiscordBotDeliveryResult;
  expiredPostingCount?: number;
  initialClaims?: readonly (typeof claim)[];
  posting?: boolean;
  saveSuccess?: boolean;
}> = {}) {
  const repository = {
    beginInitialSendPost: vi.fn(async () => input.posting ?? true),
    beginInitialSendTerminalDelivery: vi.fn(async () => true),
    claimInitialSend: vi.fn(async () => null),
    claimInitialSends: vi.fn(async () => input.initialClaims ?? []),
    claimMessageSync: vi.fn(async () => null),
    claimMessageSyncs: vi.fn(async () => []),
    markInitialSendPendingReview: vi.fn(async () => true),
    readMessageSyncState: vi.fn(async () => null),
    readOperationsControl: vi.fn(async () => ({
      enabled: true,
      epoch: input.controlEpoch ?? 7,
      pendingRemoteCleanup: false
    })),
    reconcileExpiredInitialPosts: vi.fn(async () => input.expiredPostingCount ?? 0),
    saveInitialSendFailure: vi.fn(async () => true),
    saveInitialSendSuccess: vi.fn(async () => input.saveSuccess ?? true),
    saveSyncFailure: vi.fn(async () => true),
    saveSyncSuccess: vi.fn(async () => true)
  };
  const createChannelMessage = vi.fn<DiscordBotClient["createChannelMessage"]>();
  createChannelMessage.mockResolvedValue(input.delivery ?? { kind: "sent", messageId: "message-1" });
  const deleteChannelMessage = vi.fn<DiscordBotClient["deleteChannelMessage"]>();
  deleteChannelMessage.mockResolvedValue({ kind: "removed" });
  const editChannelMessage = vi.fn<DiscordBotClient["editChannelMessage"]>();
  editChannelMessage.mockResolvedValue({ kind: "sent", messageId: "message-1" });
  const editOriginalEphemeralResponse = vi.fn<DiscordBotClient["editOriginalEphemeralResponse"]>();
  editOriginalEphemeralResponse.mockResolvedValue({ kind: "sent", messageId: "message-1" });
  const loadSnapshot = vi.fn<(reservationId: string) => Promise<DiscordReservationSnapshotResult>>();
  loadSnapshot.mockResolvedValue({
    kind: "ready",
    snapshot: {
      capacity: 10,
      closeAtUnix: 1,
      confirmedCount: 1,
      effectiveSetting: {
        capacity: 10,
        closeTime: "16:20",
        date: "2026-08-11",
        enabled: true,
        openTime: "13:00",
        studyPeriod: "EIGHTH"
      },
      remaining: 9,
      reservation: {
        date: "2026-08-11",
        id: "reservation-1",
        reason: "reason",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        user: { id: "user-1", name: "student", studentNumber: "31001" },
        userId: "user-1"
      }
    }
  });
  const sendWebhook = vi.fn<DiscordReservationOutboxDependencies["sendWebhook"]>();
  sendWebhook.mockResolvedValue({ kind: "skipped", reason: "disabled" });
  return {
    bot: {
      createChannelMessage,
      deleteChannelMessage,
      editChannelMessage,
      editOriginalEphemeralResponse
    },
    getApplicationConfig: () => ({
      adminRoleId: "role",
      adminUserBindings: [{ discordUserId: "actor", studentNumber: "31001" }],
      applicationId: "application",
      botToken: input.botToken ?? "token",
      channelId: "channel",
      guildId: "guild",
      publicKey: "public-key"
    }),
    getNotificationSettings: async () => ({
      closedPeriodNotificationsEnabled: false,
      id: "global",
      reservationCreatedNotificationsEnabled: true
    }),
    getWebhookUrl: () => undefined,
    loadSnapshot,
    repository,
    sendWebhook
  } satisfies DiscordReservationOutboxDependencies;
}

function expectInitialControlCommands(
  dependencies: ReturnType<typeof readyDependencies>,
  configuredBotToken: string,
  expectedEpoch: number
): void {
  const payload = dependencies.bot.createChannelMessage.mock.calls[0]?.[0]?.payload;
  const buttons = payload?.components?.[0]?.components;

  expect(buttons).toHaveLength(2);
  expect(JSON.stringify(payload)).not.toContain(configuredBotToken);
  expect(buttons?.map((button) => parseDiscordReservationInteraction(componentInteraction(button.custom_id), configuredBotToken)))
    .toEqual([
      expect.objectContaining({
        command: expect.objectContaining({ kind: "accept", renderedEpoch: expectedEpoch, reservationId: claim.reservationId }),
        kind: "component"
      }),
      expect.objectContaining({
        command: expect.objectContaining({ kind: "reject", renderedEpoch: expectedEpoch, reservationId: claim.reservationId }),
        kind: "component"
      })
    ]);
}

function componentInteraction(customId: string) {
  return {
    application_id: "123456789012345678",
    channel_id: "223456789012345678",
    data: { component_type: 2, custom_id: customId },
    guild_id: "323456789012345678",
    id: "423456789012345678",
    member: { roles: [], user: { id: "523456789012345678" } },
    message: { id: "623456789012345678" },
    token: "interaction-token",
    type: 3
  };
}
