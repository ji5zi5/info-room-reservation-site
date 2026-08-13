import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServerEnvError } from "./env";
import { defaultNotificationSettings } from "./notification-settings";
import { createDiscordReservationOutbox } from "./discord-reservation-outbox";
import {
  botFailure,
  claim,
  dependenciesFixture,
  now
} from "./discord-reservation-outbox-test-fixtures";

describe("Discord reservation outbox initial delivery", () => {
  let dependencies: ReturnType<typeof dependenciesFixture>;

  beforeEach(() => {
    dependencies = dependenciesFixture();
  });

  it("reconciles expired POSTING before claiming outbox work", async () => {
    const reconcileExpiredInitialPosts = vi.fn(async () => 1);
    Object.assign(dependencies.repository, { reconcileExpiredInitialPosts });

    await createDiscordReservationOutbox(dependencies)({ now });

    expect(reconcileExpiredInitialPosts).toHaveBeenCalledWith(now);
    expect(dependencies.repository.claimInitialSends).toHaveBeenCalledOnce();
    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
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
      renderedSourceEpoch: 0,
      reservationId: claim.reservationId,
      sentAt: now
    });
  });

  it("reports UNKNOWN bot delivery for review without webhook fallback", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue({
      code: "discord_timeout",
      kind: "unknown",
      message: "timeout",
      outcome: "UNKNOWN"
    });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ retried: 0, review: 1 });
    expect(dependencies.sendWebhook).not.toHaveBeenCalled();
    expect(dependencies.repository.saveInitialSendFailure).not.toHaveBeenCalled();
  });

  it("retries a definite bot failure without webhook fallback", async () => {
    dependencies.bot.createChannelMessage.mockResolvedValue(botFailure());

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ retried: 1, review: 0 });
    expect(dependencies.sendWebhook).not.toHaveBeenCalled();
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "FAILED",
      retryable: true
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
    dependencies.getApplicationConfig.mockReturnValue(null);
    dependencies.repository.saveInitialSendFailure.mockRejectedValueOnce(new Error("terminal save unavailable"));
    dependencies.repository.claimInitialSend
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({ ...claim, attempts: 2, outcome: "WEBHOOK_STARTED" });

    const first = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });
    const second = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(first.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(second.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveInitialSendFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true })
    );
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "WEBHOOK_INTERRUPTED", retryable: false })
    );
  });

  it("terminalizes an unexpected sender throw without reopening webhook retry", async () => {
    dependencies.getApplicationConfig.mockReturnValue(null);
    dependencies.sendWebhook.mockRejectedValueOnce(new Error("unexpected sender failure"));
    dependencies.repository.claimInitialSend
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({ ...claim, attempts: 2, outcome: "WEBHOOK_STARTED" });

    const first = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });
    const second = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(first.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(second.initial).toMatchObject({ retried: 0, terminal: 1 });
    expect(dependencies.sendWebhook).toHaveBeenCalledTimes(1);
    expect(dependencies.repository.saveInitialSendFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true })
    );
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "WEBHOOK_INTERRUPTED", retryable: false })
    );
  });

  it.each([
    ["partial", ["DISCORD_BOT_TOKEN"]],
    ["invalid", ["DISCORD_CHANNEL_ID"]]
  ] as const)("fails closed for %s application config", async (_kind, keys) => {
    dependencies.getApplicationConfig.mockImplementation(() => {
      throw new ServerEnvError(keys);
    });

    const result = await createDiscordReservationOutbox(dependencies)({ now, reservationId: claim.reservationId });

    expect(result.initial).toMatchObject({ claimed: 1, terminal: 1 });
    expect(dependencies.bot.createChannelMessage).not.toHaveBeenCalled();
    expect(dependencies.sendWebhook).not.toHaveBeenCalled();
    expect(dependencies.repository.saveInitialSendFailure).toHaveBeenCalledWith(expect.objectContaining({
      error: "SKIPPED_CONFIG_INVALID",
      outcome: "SKIPPED_CONFIG_INVALID",
      retryable: false
    }));
  });
});
