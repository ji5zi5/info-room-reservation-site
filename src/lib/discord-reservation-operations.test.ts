import type { Reservation } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  findReceipt: vi.fn(),
  recordDecision: vi.fn(),
  recordReceipt: vi.fn(),
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
vi.mock("./prisma-discord-reservation-message-repository", () => ({
  findDiscordInteractionTerminalResult: mocks.findReceipt,
  recordDiscordInteractionReceipt: mocks.recordReceipt,
  recordDiscordReservationDecision: mocks.recordDecision
}));

import {
  processDiscordReservationDecision,
  selectDiscordReservationSourceMessageTerminalState
} from "./discord-reservation-operations";

const now = new Date("2026-08-11T03:00:00.000Z");
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
  adminAction: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  discordReservationMessage: { findUnique: vi.fn() },
  reservation: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() }
};

describe("Discord reservation decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.systemSnapshot.mockReturnValue({
      actor: { id: "admin-1", role: "ADMIN" },
      message: { decision: null, messageId: "message-1" },
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
    transaction.adminAction.create.mockResolvedValue({ id: "accept-action" });
    transaction.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    transaction.reservation.findUnique.mockResolvedValue(reservation);
    transaction.discordReservationMessage.findUnique.mockResolvedValue({ decision: null, messageId: "message-1" });
  });

  it("accepts once under the target user lock with one receipt, revision, action, and audit", async () => {
    const result = await processDiscordReservationDecision({ command: command("accept"), now });

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

  it("rejects through the shared administrator cancellation without a second revision", async () => {
    const result = await processDiscordReservationDecision({ command: command("reject"), now });

    expect(result).toEqual({ kind: "cancelled", reservationId: "reservation-1" });
    expect(mocks.recordDecision).toHaveBeenCalledWith(transaction, expect.objectContaining({
      decision: "CANCELLED",
      revision: "PRESERVE"
    }));
    expect(mocks.cancel).toHaveBeenCalledWith(transaction, {
      actor: { id: "admin-1", role: "ADMIN" },
      ipHash: expect.any(String),
      reason: "행사 준비",
      reservationId: "reservation-1",
      source: { kind: "DISCORD_REJECTION" }
    });
    expect(transaction.adminAction.create).not.toHaveBeenCalled();
  });

  it("replays a duplicate interaction without another mutation, audit, or revision", async () => {
    mocks.findReceipt.mockResolvedValue({ kind: "accepted", reservationId: "reservation-1" });
    transaction.discordReservationMessage.findUnique.mockResolvedValue(null);

    const result = await processDiscordReservationDecision({ command: command("accept"), now });

    expect(result).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(transaction.adminAction.create).not.toHaveBeenCalled();
  });

  it("returns the first reservation outcome when a different interaction loses the receipt race", async () => {
    mocks.recordReceipt.mockResolvedValue({
      kind: "replayed",
      terminalResult: { kind: "accepted", reservationId: "reservation-1" }
    });

    const result = await processDiscordReservationDecision({ command: command("reject"), now });

    expect(result).toEqual({ kind: "accepted", reservationId: "reservation-1" });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["missing mapping", null, "actor_not_found"],
    ["non-admin mapping", { id: "student-actor", role: "STUDENT" }, "actor_not_admin"]
  ])("does not enter a mutation for %s", async (_scenario, actor, code) => {
    mocks.systemSnapshot.mockReturnValue({
      actor,
      message: { decision: null, messageId: "message-1" },
      reservation: { id: "reservation-1", status: "CONFIRMED", userId: "student-1" }
    });

    const result = await processDiscordReservationDecision({ command: command("accept"), now });

    expect(result).toEqual({ code, kind: "noop" });
    expect(mocks.withDatabaseMutation).not.toHaveBeenCalled();
  });

  it("rejects a stale local admin or source message inside the mutation path", async () => {
    transaction.user.findUnique.mockResolvedValue({ id: "admin-1", role: "STUDENT" });

    const result = await processDiscordReservationDecision({ command: command("accept"), now });

    expect(result).toEqual({ code: "stale_actor", kind: "noop" });
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it("returns a typed no-op when the source message disappeared without a receipt", async () => {
    transaction.discordReservationMessage.findUnique.mockResolvedValue(null);

    const result = await processDiscordReservationDecision({ command: command("accept"), now });

    expect(result).toEqual({ code: "stale_message", kind: "noop" });
    expect(mocks.recordReceipt).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it("returns a typed no-op when the reservation disappeared before mutation", async () => {
    mocks.systemSnapshot.mockReturnValue({
      actor: { id: "admin-1", role: "ADMIN" },
      reservation: null
    });

    const result = await processDiscordReservationDecision({ command: command("accept"), now });

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
