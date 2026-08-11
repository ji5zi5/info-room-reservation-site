import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDiscordReservationMessage,
  prismaDiscordReservationMessageRepository,
  recordDiscordInteractionReceipt,
  recordDiscordReservationDecision
} from "@/lib/prisma-discord-reservation-message-repository";

import {
  prisma,
  resetPostgresTestDatabase,
  seedUser,
  withAdminDatabaseContext,
  withStudentDatabaseContext,
  withSystemDatabaseContext
} from "./postgres-test-db";

const now = new Date("2026-08-11T00:00:00.000Z");

beforeEach(resetPostgresTestDatabase);
afterAll(async () => {
  await resetPostgresTestDatabase();
  await prisma.$disconnect();
});

describe("durable Discord reservation operations", () => {
  it("creates the reservation and deterministic send nonce atomically with unique identities", async () => {
    const user = await seedUser({ id: "discord-atomic" });

    const reservationId = await withSystemDatabaseContext(async (transaction) => {
      const reservation = await transaction.reservation.create({
        data: { date: "2026-08-12", status: "CONFIRMED", studyPeriod: "EIGHTH", userId: user.id }
      });
      await createDiscordReservationMessage(transaction, { nonce: "reservation-nonce", now, reservationId: reservation.id });
      return reservation.id;
    });

    await expect(withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }))).resolves.toMatchObject({ nonce: "reservation-nonce" });
    await expect(prismaDiscordReservationMessageRepository.create({ nonce: "reservation-nonce", now, reservationId })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows only one active claim and recovers at the exact 120-second lease boundary", async () => {
    const reservationId = await seedMessage("claim", "claim-nonce");

    const [left, right] = await Promise.all([
      prismaDiscordReservationMessageRepository.claimInitialSends(now),
      prismaDiscordReservationMessageRepository.claimInitialSends(now)
    ]);

    expect([...left, ...right]).toHaveLength(1);
    const firstClaim = [...left, ...right][0];
    expect(firstClaim?.reservationId).toBe(reservationId);
    await withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.update({
      data: { initialSendClaimedAt: new Date(now.getTime() - 120_000) }, where: { reservationId }
    }));
    const recovered = await prismaDiscordReservationMessageRepository.claimInitialSends(now);
    expect(recovered).toHaveLength(1);
    await expect(prismaDiscordReservationMessageRepository.saveInitialSendSuccess({
      channelId: "channel", claimId: firstClaim?.claimId ?? "missing", guildId: "guild",
      messageId: "message", reservationId, sentAt: now
    })).resolves.toBe(false);
  });

  it("caps claims at 20 rows", async () => {
    await Promise.all(Array.from({ length: 21 }, (_, index) => seedMessage(`batch-${index}`, `nonce-${index}`)));

    const claims = await prismaDiscordReservationMessageRepository.claimInitialSends(now);

    expect(claims).toHaveLength(20);
  });

  it("replays a unique terminal receipt and keeps the first reservation decision", async () => {
    const reservationId = await seedMessage("receipt", "receipt-nonce");
    const firstResult = { kind: "accepted", reservationId };
    await withSystemDatabaseContext(async (transaction) => {
      await expect(recordDiscordReservationDecision(transaction, { decision: "ACCEPTED", discordActorId: "discord-actor", localActorId: "local-admin", now, reservationId })).resolves.toBe(true);
      await recordDiscordInteractionReceipt(transaction, receipt("interaction-1", reservationId, firstResult));
    });

    const replay = await withSystemDatabaseContext(async (transaction) => {
      await expect(recordDiscordReservationDecision(transaction, { decision: "CANCELLED", discordActorId: "other", localActorId: "other-admin", now, reservationId })).resolves.toBe(false);
      return recordDiscordInteractionReceipt(transaction, receipt("interaction-2", reservationId, { kind: "cancelled", reservationId }));
    });

    expect(replay).toEqual({ kind: "replayed", terminalResult: firstResult });
    await expect(withSystemDatabaseContext((transaction) => transaction.discordInteractionReceipt.count({ where: { reservationId } }))).resolves.toBe(1);
  });

  it("increments the outbox revision when any reservation writer makes it terminal", async () => {
    const reservationId = await seedMessage("revision", "revision-nonce");

    await withSystemDatabaseContext((transaction) => transaction.reservation.update({ data: { status: "CANCELLED" }, where: { id: reservationId } }));

    await expect(withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }))).resolves.toMatchObject({ messageRevision: 1, syncStatus: "PENDING" });
  });

  it("denies students and permits ADMIN/SYSTEM through RLS", async () => {
    const [admin, student] = await Promise.all([seedUser({ id: "discord-admin", role: "ADMIN" }), seedUser({ id: "discord-student" })]);
    await seedMessageForUser(student.id, "rls", "rls-nonce");

    await expect(withStudentDatabaseContext(student.id, (transaction) => transaction.discordReservationMessage.count())).resolves.toBe(0);
    await expect(withAdminDatabaseContext(admin.id, (transaction) => transaction.discordReservationMessage.count())).resolves.toBe(1);
    await expect(withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.count())).resolves.toBe(1);
    const deniedReservation = await withSystemDatabaseContext((transaction) => transaction.reservation.create({
      data: { date: "2026-08-12", status: "CONFIRMED", studyPeriod: "RLS_DENIED", userId: student.id }
    }));
    await expect(withStudentDatabaseContext(student.id, (transaction) => transaction.discordReservationMessage.create({
      data: { nonce: "student-denied", reservationId: deniedReservation.id }
    }))).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("deletes expired terminal messages then receipts in bounded batches", async () => {
    const reservationId = await seedMessage("cleanup", "cleanup-nonce");
    await withSystemDatabaseContext(async (transaction) => {
      await transaction.discordReservationMessage.update({
        data: { expiresAt: now, initialSendStatus: "SENT", syncStatus: "SYNCED" }, where: { reservationId }
      });
      await transaction.discordInteractionReceipt.create({ data: { ...receipt("cleanup-interaction", reservationId, { kind: "accepted" }), expiresAt: now } });
    });

    const messages = await prismaDiscordReservationMessageRepository.deleteExpiredMessages(now);
    const receipts = await prismaDiscordReservationMessageRepository.deleteExpiredInteractionReceipts(now);

    expect(messages).toMatchObject({ processedCount: 1 });
    expect(receipts).toMatchObject({ processedCount: 1 });
  });
});

function receipt(interactionId: string, reservationId: string, terminalResult: Prisma.InputJsonValue) {
  return {
    discordActorId: "discord-actor", interactionId, intent: "ACCEPT", localActorId: "local-admin",
    messageId: "discord-message", reservationId, status: "TERMINAL" as const,
    terminalOutcome: "ACCEPTED", terminalResult
  };
}

async function seedMessage(suffix: string, nonce: string): Promise<string> {
  const user = await seedUser({ id: `discord-${suffix}` });
  return seedMessageForUser(user.id, suffix, nonce);
}

async function seedMessageForUser(userId: string, suffix: string, nonce: string): Promise<string> {
  return withSystemDatabaseContext(async (transaction) => {
    const reservation = await transaction.reservation.create({
      data: { date: "2026-08-12", status: "CONFIRMED", studyPeriod: suffix, userId }
    });
    await createDiscordReservationMessage(transaction, { nonce, now, reservationId: reservation.id });
    return reservation.id;
  });
}
