import { describe, expect, it, vi } from "vitest";

import type { DiscordReservationOutboxDependencies } from "./discord-reservation-outbox-contracts";
import type { DiscordBotClient, DiscordBotDeliveryResult } from "./discord-bot";
import type { DiscordReservationSnapshotResult } from "./discord-reservation-snapshot";
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
});

function readyDependencies(input: Readonly<{
  delivery?: DiscordBotDeliveryResult;
  expiredPostingCount?: number;
  posting?: boolean;
  saveSuccess?: boolean;
}> = {}) {
  const repository = {
    beginInitialSendPost: vi.fn(async () => input.posting ?? true),
    beginInitialSendTerminalDelivery: vi.fn(async () => true),
    claimInitialSend: vi.fn(async () => null),
    claimInitialSends: vi.fn(async () => []),
    claimMessageSync: vi.fn(async () => null),
    claimMessageSyncs: vi.fn(async () => []),
    markInitialSendPendingReview: vi.fn(async () => true),
    readMessageSyncState: vi.fn(async () => null),
    readOperationsControl: vi.fn(async () => ({ enabled: true, epoch: 7, pendingRemoteCleanup: false })),
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
      botToken: "token",
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
