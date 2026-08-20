import type { Reservation } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  findReceipt: vi.fn(),
  recordDecision: vi.fn(),
  recordReceipt: vi.fn(),
  noShow: vi.fn(),
  systemSnapshot: vi.fn(),
  withDatabaseContext: vi.fn(),
  withDatabaseMutation: vi.fn()
}));

vi.mock("./db", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  userMutationLockKey: (userId: string) => `user:${userId}`,
  withDatabaseContext: mocks.withDatabaseContext,
  withDatabaseMutation: mocks.withDatabaseMutation
}));
vi.mock("./admin-reservation-operations", () => ({
  cancelAdministratorReservationInTransaction: mocks.cancel
}));
vi.mock("./admin-no-show-operations", () => ({
  markAdministratorReservationNoShowInTransaction: mocks.noShow
}));
vi.mock("./prisma-discord-reservation-message-repository", () => ({
  findDiscordInteractionTerminalResult: mocks.findReceipt,
  recordDiscordReservationDecision: mocks.recordDecision
}));
vi.mock("./prisma-discord-reservation-message-interactions", () => ({
  recordDiscordOperationReceipt: mocks.recordReceipt
}));

import {
  processDiscordReservationOperation,
  processDiscordReservationDecision,
  selectDiscordReservationSourceMessageTerminalState
} from "./discord-reservation-operations";

const now = new Date("2026-08-11T03:00:00.000Z");
const currentApplicationId = "application-1";
const ipHash = "transport-derived-ip-hash";
const reservation: Reservation = {
  createdAt: now,
  date: "2026-08-12",
  id: "reservation-1",
  reason: "자습",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  updatedAt: now,
  userId: "student-1"
};
const transaction = {
  $queryRaw: vi.fn(),
  adminAction: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  discordInteractionJob: { findUnique: vi.fn() },
  discordReservationMessage: { findUnique: vi.fn() },
  discordOperationsControl: { findUnique: vi.fn() },
  reservation: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() }
};

describe("Discord reservation decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.systemSnapshot.mockReturnValue({
      actor: { id: "admin-1", role: "ADMIN", studentNumber: "test-admin-1" },
      message: {
        channelId: "channel-1",
        decision: null,
        guildId: "guild-1",
        messageId: "message-1",
        renderedSourceEpoch: 7
      },
      reservation: { id: "reservation-1", status: "CONFIRMED", userId: "student-1" }
    });
    mocks.withDatabaseContext.mockImplementation(async () => mocks.systemSnapshot());
    mocks.withDatabaseMutation.mockImplementation(async (input) => input.operation(transaction));
    mocks.findReceipt.mockResolvedValue(null);
    mocks.recordReceipt.mockImplementation(async (_transaction, input) => ({
      kind: "inserted",
      terminalResult: input.terminalResult
    }));
    mocks.recordDecision.mockResolvedValue(true);
    mocks.cancel.mockResolvedValue({ kind: "ok", reservation: { ...reservation, status: "CANCELLED" } });
    mocks.noShow.mockResolvedValue({ kind: "ok", reservation: { ...reservation, status: "NO_SHOW" } });
    transaction.adminAction.create.mockResolvedValue({ id: "accept-action" });
    transaction.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN", studentNumber: "test-admin-1" });
    transaction.reservation.findUnique.mockResolvedValue(reservation);
    transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1", decision: null, guildId: "guild-1", messageId: "message-1", renderedSourceEpoch: 7
    });
    transaction.discordInteractionJob.findUnique.mockResolvedValue({ sourceApplicationId: currentApplicationId });
    transaction.discordOperationsControl.findUnique.mockResolvedValue({ enabled: true, epoch: 7 });
    transaction.$queryRaw.mockResolvedValue([{ enabled: true, epoch: 7 }]);
  });

  it("persists the exact transport-derived ipHash when accepting once", async () => {
    const result = await processDiscordReservationDecision({ command: command("accept"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.withDatabaseMutation).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: "admin-1", role: "ADMIN" },
      lockKeys: ["user:student-1"]
    }));
    expect(mocks.recordDecision).toHaveBeenCalledWith(transaction, expect.objectContaining({
      decision: "ACCEPTED",
      discordActorId: "discord-1",
      localActorId: "admin-1",
      revision: "INCREMENT"
    }));
    expect(transaction.adminAction.create).toHaveBeenCalledTimes(1);
    expect(transaction.auditLog.create).toHaveBeenCalledTimes(1);
    expect(transaction.adminAction.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "DISCORD_RESERVATION_ACCEPT",
      actorId: "admin-1",
      ipHash,
      reservationId: "reservation-1",
      targetUserId: "student-1"
    }) });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "DISCORD_RESERVATION_ACCEPT",
      actorId: "admin-1",
      detail: JSON.stringify({ actionId: "accept-action", discordActorId: "discord-1", reservationId: "reservation-1" }),
      userId: "student-1"
    }) });
    expect(mocks.recordReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.recordReceipt).toHaveBeenCalledWith(transaction, expect.objectContaining({
      discordActorId: "discord-1",
      interactionId: "interaction-1",
      localActorId: "admin-1",
      terminalOutcome: "ACCEPTED"
    }));
    expect(JSON.stringify(mocks.recordReceipt.mock.calls[0]?.[1])).not.toContain("secret-token");
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("passes the exact transport-derived ipHash to shared rejection cancellation", async () => {
    const result = await processDiscordReservationDecision({ command: command("reject"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ kind: "cancelled", reservationId: "reservation-1" });
    expect(mocks.recordDecision).toHaveBeenCalledWith(transaction, expect.objectContaining({
      decision: "CANCELLED",
      revision: "PRESERVE"
    }));
    expect(mocks.cancel).toHaveBeenCalledWith(transaction, {
      actor: { id: "admin-1", role: "ADMIN" },
      ipHash,
      reason: "행사 준비",
      reservationId: "reservation-1",
      source: { kind: "DISCORD_REJECTION" }
    });
    expect(transaction.adminAction.create).not.toHaveBeenCalled();
  });

  it("replays a duplicate interaction without another mutation, audit, or revision", async () => {
    mocks.findReceipt.mockResolvedValue({ kind: "accepted", reservationId: "reservation-1" });
    transaction.discordReservationMessage.findUnique.mockResolvedValue(null);

    const result = await processDiscordReservationDecision({ command: command("accept"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(transaction.adminAction.create).not.toHaveBeenCalled();
  });

  it("does not replay a receipt from a different interaction id", async () => {

    const result = await processDiscordReservationDecision({ command: command("reject"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ kind: "cancelled", reservationId: "reservation-1" });
    expect(mocks.recordDecision).toHaveBeenCalledOnce();
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it("returns the first settled decision to a competing interaction without another receipt", async () => {
    transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1", decision: "ACCEPTED", guildId: "guild-1",
      messageId: "message-1", renderedSourceEpoch: 7
    });

    const result = await processDiscordReservationDecision({ command: command("reject"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("binds the legacy direct path to the explicitly supplied current application", async () => {
    transaction.discordInteractionJob.findUnique.mockResolvedValue(null);

    const result = await processDiscordReservationDecision({
      command: command("accept"),
      currentApplicationId,
      ipHash,
      now
    });

    expect(result).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.recordDecision).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing mapping", null, "actor_not_found"],
    ["non-admin mapping", { id: "student-actor", role: "STUDENT" }, "actor_not_admin"]
  ])("does not enter a mutation for %s", async (_scenario, actor, code) => {
    mocks.systemSnapshot.mockReturnValue({
      actor,
      message: {
        channelId: "channel-1", decision: null, guildId: "guild-1",
        messageId: "message-1", renderedSourceEpoch: 7
      },
      reservation: { id: "reservation-1", status: "CONFIRMED", userId: "student-1" }
    });

    const result = await processDiscordReservationDecision({ command: command("accept"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ code, kind: "noop" });
    expect(mocks.withDatabaseMutation).not.toHaveBeenCalled();
  });

  it("rejects a stale local admin or source message inside the mutation path", async () => {
    transaction.user.findUnique.mockResolvedValue({ id: "admin-1", role: "STUDENT" });

    const result = await processDiscordReservationDecision({ command: command("accept"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ code: "stale_actor", kind: "noop" });
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it("returns a typed no-op when the source message disappeared without a receipt", async () => {
    transaction.discordReservationMessage.findUnique.mockResolvedValue(null);

    const result = await processDiscordReservationDecision({ command: command("accept"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ code: "stale_message", kind: "noop" });
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it("returns a typed no-op when the reservation disappeared before mutation", async () => {
    mocks.systemSnapshot.mockReturnValue({
      actor: { id: "admin-1", role: "ADMIN", studentNumber: "test-admin-1" },
      message: {
        channelId: "channel-1",
        guildId: "guild-1",
        renderedSourceEpoch: 7
      },
      reservation: null
    });

    const result = await processDiscordReservationDecision({ command: command("accept"), currentApplicationId, ipHash, now });

    expect(result).toEqual({ code: "reservation_not_found", kind: "noop" });
    expect(mocks.withDatabaseMutation).not.toHaveBeenCalled();
  });

  it("ranks actual cancellation and no-show above an accepted Discord decision", () => {
    expect(selectDiscordReservationSourceMessageTerminalState({
      cancellationReason: "관리자 취소",
      decision: "ACCEPTED",
      reservationStatus: "CANCELLED"
    })).toEqual({ cancellationReason: "관리자 취소", kind: "cancelled" });
    expect(selectDiscordReservationSourceMessageTerminalState({
      cancellationReason: null,
      decision: "ACCEPTED",
      reservationStatus: "NO_SHOW"
    })).toEqual({ kind: "stale" });
    expect(selectDiscordReservationSourceMessageTerminalState({
      cancellationReason: null,
      decision: "ACCEPTED",
      reservationStatus: "CONFIRMED"
    })).toEqual({ kind: "accepted" });
  });

  it("cancels an accepted reservation with a second receipt and the exact Discord admin source", async () => {
    // Given
    transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1",
      decision: "ACCEPTED",
      guildId: "guild-1",
      messageId: "message-1",
      renderedSourceEpoch: 7
    });

    // When
    const result = await processDiscordReservationOperation({
      command: lifecycleCommand("admin_cancel"), currentApplicationId: "application-1", ipHash, now
    });

    // Then
    expect(result).toEqual({ kind: "cancelled", reservationId: "reservation-1" });
    expect(mocks.cancel).toHaveBeenCalledWith(transaction, expect.objectContaining({
      ipHash,
      source: { kind: "DISCORD_ADMIN_CANCEL" }
    }));
    expect(mocks.recordReceipt).toHaveBeenCalledWith(transaction, expect.objectContaining({
      interactionId: "interaction-follow-up",
      intent: "ADMIN_CANCEL"
    }));
  });

  it("marks an accepted closed reservation no-show through the shared service", async () => {
    // Given
    transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1",
      decision: "ACCEPTED",
      guildId: "guild-1",
      messageId: "message-1",
      renderedSourceEpoch: 7
    });

    // When
    const result = await processDiscordReservationOperation({
      command: lifecycleCommand("no_show"), currentApplicationId: "application-1", ipHash, now
    });

    // Then
    expect(result).toEqual({ kind: "no_show", reservationId: "reservation-1" });
    expect(mocks.noShow).toHaveBeenCalledWith(transaction, expect.objectContaining({
      ipHash,
      now,
      reason: "운영 처리"
    }));
  });

  it("does not mutate when the rendered control epoch differs from current control", async () => {
    // Given
    transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1",
      decision: "ACCEPTED",
      guildId: "guild-1",
      messageId: "message-1",
      renderedSourceEpoch: 6
    });

    // When
    const result = await processDiscordReservationOperation({
      command: lifecycleCommand("admin_cancel"), currentApplicationId: "application-1", ipHash, now
    });

    // Then
    expect(result).toEqual({ code: "stale_control", kind: "noop" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.noShow).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("allows the persisted current epoch, then stales it after epoch advancement", async () => {
    // Given
    let currentEpoch = 7;
    let renderedSourceEpoch = 7;
    transaction.$queryRaw.mockImplementation(async () => [{ enabled: true, epoch: currentEpoch }]);
    transaction.discordReservationMessage.findUnique.mockImplementation(async () => ({
      channelId: "channel-1",
      decision: null,
      guildId: "guild-1",
      messageId: "message-1",
      renderedSourceEpoch
    }));
    const epochSevenCommand = operationCommand("accept", "interaction-epoch-7");

    // When / Then: the initially rendered and persisted epoch is current.
    await expect(processDiscordReservationOperation({
      command: epochSevenCommand,
      currentApplicationId,
      ipHash,
      now
    })).resolves.toEqual({ kind: "accepted", reservationId: "reservation-1" });

    // When / Then: advancing only current control makes the old rendered control stale.
    currentEpoch = 8;
    await expect(processDiscordReservationOperation({
      command: epochSevenCommand,
      currentApplicationId,
      ipHash,
      now
    })).resolves.toEqual({ code: "stale_control", kind: "noop" });

    // When / Then: freshly rendering and persisting epoch 8 restores the valid path.
    renderedSourceEpoch = 8;
    await expect(processDiscordReservationOperation({
      command: {
        ...operationCommand("accept", "interaction-epoch-8"),
        renderedControlEpoch: 8
      },
      currentApplicationId,
      ipHash,
      now
    })).resolves.toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.recordDecision).toHaveBeenCalledTimes(2);
  });

  it("records two interaction receipts for accept followed by administrator cancellation", async () => {
    // Given
    let message = {
      channelId: "channel-1", decision: null as string | null, guildId: "guild-1",
      messageId: "message-1", renderedSourceEpoch: 7
    };
    transaction.discordReservationMessage.findUnique.mockImplementation(async () => message);
    mocks.recordDecision.mockImplementation(async (_transaction, write) => {
      message = { ...message, decision: write.decision };
      return true;
    });

    // When
    const accepted = await processDiscordReservationOperation({ command: operationCommand("accept", "interaction-accept"), currentApplicationId: "application-1", ipHash, now });
    const cancelled = await processDiscordReservationOperation({ command: operationCommand("admin_cancel", "interaction-cancel"), currentApplicationId: "application-1", ipHash, now });

    // Then
    expect(accepted).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(cancelled).toEqual({ kind: "cancelled", reservationId: "reservation-1" });
    expect(mocks.recordReceipt.mock.calls.map((call) => call[1].intent)).toEqual(["ACCEPT", "ADMIN_CANCEL"]);
    expect(mocks.cancel).toHaveBeenCalledWith(transaction, expect.objectContaining({ source: { kind: "DISCORD_ADMIN_CANCEL" } }));
  });

  it("records two interaction receipts for accept followed by closed no-show", async () => {
    // Given
    let message = {
      channelId: "channel-1", decision: null as string | null, guildId: "guild-1",
      messageId: "message-1", renderedSourceEpoch: 7
    };
    transaction.discordReservationMessage.findUnique.mockImplementation(async () => message);
    mocks.recordDecision.mockImplementation(async (_transaction, write) => {
      message = { ...message, decision: write.decision };
      return true;
    });

    // When
    const accepted = await processDiscordReservationOperation({ command: operationCommand("accept", "interaction-accept"), currentApplicationId: "application-1", ipHash, now });
    const noShow = await processDiscordReservationOperation({ command: operationCommand("no_show", "interaction-no-show"), currentApplicationId: "application-1", ipHash, now });

    // Then
    expect(accepted).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(noShow).toEqual({ kind: "no_show", reservationId: "reservation-1" });
    expect(mocks.recordReceipt.mock.calls.map((call) => call[1].intent)).toEqual(["ACCEPT", "NO_SHOW"]);
    expect(mocks.noShow).toHaveBeenCalledOnce();
  });

  it("rejects pre-close no-show without a source-message transition or receipt", async () => {
    // Given
    transaction.discordReservationMessage.findUnique.mockResolvedValue({
      channelId: "channel-1", decision: "ACCEPTED", guildId: "guild-1",
      messageId: "message-1", renderedSourceEpoch: 7
    });
    mocks.noShow.mockResolvedValue({ kind: "not_closed" });

    // When
    const result = await processDiscordReservationOperation({ command: operationCommand("no_show", "interaction-no-show"), currentApplicationId: "application-1", ipHash, now });

    // Then
    expect(result).toEqual({ code: "not_closed", kind: "noop" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("rejects operations while Discord controls are disabled", async () => {
    // Given
    transaction.$queryRaw.mockResolvedValue([{ enabled: false, epoch: 7 }]);

    // When
    const result = await processDiscordReservationOperation({ command: operationCommand("accept", "interaction-accept"), currentApplicationId: "application-1", ipHash, now });

    // Then
    expect(result).toEqual({ code: "stale_control", kind: "noop" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("does not mutate when the persisted source application differs from current configuration", async () => {
    // Given / When
    const result = await processDiscordReservationOperation({
      command: operationCommand("accept", "interaction-wrong-app"),
      currentApplicationId: "application-2",
      ipHash,
      now
    });

    // Then
    expect(result).toEqual({ code: "stale_application", kind: "noop" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("does not mutate an unbound legacy command", async () => {
    const result = await processDiscordReservationOperation({
      command: { ...operationCommand("accept", "interaction-unbound"), sourceApplicationId: null },
      currentApplicationId,
      ipHash,
      now
    });

    expect(result).toEqual({ code: "stale_application", kind: "noop" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("does not mutate when the durable job application differs from its command", async () => {
    transaction.discordInteractionJob.findUnique.mockResolvedValue({ sourceApplicationId: "application-2" });

    const result = await processDiscordReservationOperation({
      command: operationCommand("accept", "interaction-job-mismatch"),
      currentApplicationId,
      ipHash,
      now
    });

    expect(result).toEqual({ code: "stale_application", kind: "noop" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });

  it("does not mutate a job-backed command after its durable job disappears", async () => {
    transaction.discordInteractionJob.findUnique.mockResolvedValue(null);

    const result = await processDiscordReservationOperation({
      command: operationCommand("accept", "interaction-missing-job"),
      currentApplicationId,
      ipHash,
      now
    });

    expect(result).toEqual({ code: "stale_application", kind: "noop" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
  });
});

function command(kind: "accept" | "reject") {
  const base = {
    discordActorId: "discord-1",
    interactionId: "interaction-1",
    interactionToken: "secret-token",
    reservationId: "reservation-1",
    sourceMessageId: "message-1",
    studentNumber: "test-admin-1"
  } as const;
  return kind === "accept" ? { ...base, kind } as const : { ...base, kind, reason: "행사 준비" } as const;
}

function lifecycleCommand(kind: "admin_cancel" | "no_show") {
  const base = {
    discordActorId: "discord-1",
    interactionId: "interaction-follow-up",
    localActorId: "admin-1",
    renderedControlEpoch: 7,
    reservationId: "reservation-1",
    sourceApplicationId: "application-1",
    sourceChannelId: "channel-1",
    sourceGuildId: "guild-1",
    sourceMessageId: "message-1",
    studentNumber: "test-admin-1"
  } as const;
  return { ...base, kind, reason: "운영 처리" } as const;
}

function operationCommand(
  kind: "accept" | "admin_cancel" | "no_show",
  interactionId: string
) {
  const base = { ...lifecycleCommand("no_show"), interactionId };
  switch (kind) {
    case "accept":
      return { ...base, kind } as const;
    case "admin_cancel":
      return { ...base, kind, reason: "운영 처리" } as const;
    case "no_show":
      return { ...base, kind, reason: "운영 처리" } as const;
  }
}
