import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDiscordReservationMessage,
  prismaDiscordReservationMessageRepository,
  recordDiscordInteractionReceipt
} from "@/lib/prisma-discord-reservation-message-repository";
import { processDiscordReservationDecision } from "@/lib/discord-reservation-operations";

import {
  prisma,
  resetPostgresTestDatabase,
  seedUser,
  withAdminDatabaseContext,
  withStudentDatabaseContext,
  withSystemDatabaseContext
} from "./postgres-test-db";

const now = new Date("2026-08-11T00:00:00.000Z");
const ipHash = "integration-request-source-hash";
const currentApplicationId = "integration-application";

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
      messageId: "message", renderedSourceEpoch: 7, reservationId, sentAt: now
    })).resolves.toBe(false);
  });

  it("caps claims at 20 rows", async () => {
    await Promise.all(Array.from({ length: 21 }, (_, index) => seedMessage(`batch-${index}`, `nonce-${index}`)));

    const claims = await prismaDiscordReservationMessageRepository.claimInitialSends(now);

    expect(claims).toHaveLength(20);
  });

  it("accepts once and replays the terminal receipt without another audit or revision", async () => {
    const admin = await seedUser({ id: "discord-accept-admin", role: "ADMIN" });
    const reservationId = await seedMessage("accept", "accept-nonce");
    await markMessageSent(reservationId, "accept-message");
    const command = decisionCommand({ interactionId: "accept-interaction", kind: "accept", reservationId, sourceMessageId: "accept-message", studentNumber: admin.studentNumber });

    await expect(processDiscordReservationDecision({ command, currentApplicationId, ipHash, now })).resolves.toEqual({ kind: "accepted", reservationId });
    await expect(processDiscordReservationDecision({ command, currentApplicationId, ipHash, now })).resolves.toEqual({ kind: "accepted", reservationId });

    const stored = await withSystemDatabaseContext(async (transaction) => ({
      actionCount: await transaction.adminAction.count({ where: { action: "DISCORD_RESERVATION_ACCEPT", reservationId } }),
      auditCount: await transaction.auditLog.count({ where: { action: "DISCORD_RESERVATION_ACCEPT", actorId: admin.id } }),
      message: await transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }),
      receiptCount: await transaction.discordInteractionReceipt.count({ where: { reservationId } }),
      reservation: await transaction.reservation.findUniqueOrThrow({ where: { id: reservationId } })
    }));
    expect(stored).toMatchObject({ actionCount: 1, auditCount: 1, receiptCount: 1, reservation: { status: "CONFIRMED" } });
    expect(stored.message).toMatchObject({ decision: "ACCEPTED", decisionDiscordActorId: "discord-actor", decisionLocalActorId: admin.id, messageRevision: 1, syncStatus: "PENDING" });
  });

  it("rejects through the shared cancellation audit with one trigger revision", async () => {
    const admin = await seedUser({ id: "discord-reject-admin", role: "ADMIN" });
    const reservationId = await seedMessage("reject", "reject-nonce");
    await markMessageSent(reservationId, "reject-message");

    await expect(processDiscordReservationDecision({ command: { ...decisionCommand({ interactionId: "reject-interaction", kind: "reject", reservationId, sourceMessageId: "reject-message", studentNumber: admin.studentNumber }), reason: "행사 준비" }, currentApplicationId, ipHash, now })).resolves.toEqual({ kind: "cancelled", reservationId });

    const stored = await withSystemDatabaseContext(async (transaction) => ({
      action: await transaction.adminAction.findFirstOrThrow({ where: { reservationId } }),
      audit: await transaction.auditLog.findFirstOrThrow({ where: { action: "ADMIN_RESERVATION_CANCEL", actorId: admin.id } }),
      message: await transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }),
      reservation: await transaction.reservation.findUniqueOrThrow({ where: { id: reservationId } })
    }));
    expect(stored.action).toMatchObject({ action: "ADMIN_RESERVATION_CANCEL", actorId: admin.id, reason: "행사 준비" });
    expect(JSON.parse(stored.audit.detail)).toMatchObject({ reason: "행사 준비", source: "DISCORD_REJECTION" });
    expect(stored.message).toMatchObject({ decision: "CANCELLED", messageRevision: 1 });
    expect(stored.reservation.status).toBe("CANCELLED");
  });

  it("keeps the first concurrent accept-versus-reject terminal outcome", async () => {
    const admin = await seedUser({ id: "discord-race-admin", role: "ADMIN" });
    const reservationId = await seedMessage("race", "race-nonce");
    await markMessageSent(reservationId, "race-message");
    const accept = decisionCommand({ interactionId: "race-accept", kind: "accept", reservationId, sourceMessageId: "race-message", studentNumber: admin.studentNumber });
    const reject = { ...decisionCommand({ interactionId: "race-reject", kind: "reject", reservationId, sourceMessageId: "race-message", studentNumber: admin.studentNumber }), reason: "경합 거절" } as const;

    const results = await Promise.all([
      processDiscordReservationDecision({ command: accept, currentApplicationId, ipHash, now }),
      processDiscordReservationDecision({ command: reject, currentApplicationId, ipHash, now })
    ]);

    expect(results[0]).toEqual(results[1]);
    const counts = await withSystemDatabaseContext(async (transaction) => ({
      actions: await transaction.adminAction.count({ where: { reservationId } }),
      audits: await transaction.auditLog.count({ where: { actorId: admin.id } }),
      message: await transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }),
      receipts: await transaction.discordInteractionReceipt.count({ where: { reservationId } })
    }));
    expect(counts).toMatchObject({ actions: 1, audits: 1, receipts: 1 });
    expect(counts.message.messageRevision).toBe(1);
  });

  it("increments the outbox revision when any reservation writer makes it terminal", async () => {
    const reservationId = await seedMessage("revision", "revision-nonce");

    await withSystemDatabaseContext((transaction) => transaction.reservation.update({ data: { status: "CANCELLED" }, where: { id: reservationId } }));

    await expect(withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }))).resolves.toMatchObject({ messageRevision: 1, syncStatus: "PENDING" });
  });

  it("prevents a stale sync claim from saving after a newer terminal revision", async () => {
    const admin = await seedUser({ id: "discord-stale-admin", role: "ADMIN" });
    const reservationId = await seedMessage("stale", "stale-nonce");
    await markMessageSent(reservationId, "stale-message");
    await processDiscordReservationDecision({ command: decisionCommand({ interactionId: "stale-interaction", kind: "accept", reservationId, sourceMessageId: "stale-message", studentNumber: admin.studentNumber }), currentApplicationId, ipHash, now });
    const [claim] = await prismaDiscordReservationMessageRepository.claimMessageSyncs(now);
    await withSystemDatabaseContext((transaction) => transaction.reservation.update({ data: { status: "NO_SHOW" }, where: { id: reservationId } }));

    await expect(prismaDiscordReservationMessageRepository.saveSyncSuccess({ claimId: claim?.claimId ?? "missing", reservationId, revision: claim?.revision ?? -1, syncedAt: now })).resolves.toBe(false);
    await expect(withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }))).resolves.toMatchObject({ messageRevision: 2, syncStatus: "PENDING", syncedRevision: 0 });
  });

  it("grants runtime CRUD while RLS denies students and permits ADMIN/SYSTEM", async () => {
    const privileges = await withSystemDatabaseContext((transaction) => transaction.$queryRaw<
      readonly { readonly granted: boolean; readonly privilege: string; readonly tableName: string }[]
    >`
      SELECT tables.name AS "tableName", privileges.name AS "privilege",
        has_table_privilege(current_user, format('public.%I', tables.name), privileges.name) AS "granted"
      FROM (VALUES ('DiscordReservationMessage'), ('DiscordInteractionReceipt')) AS tables(name)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privileges(name)
      ORDER BY tables.name, privileges.name
    `);
    expect(privileges).toHaveLength(8);
    expect(privileges.every(({ granted }) => granted)).toBe(true);

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
    }))).rejects.toThrow();
    await expect(withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.count({
      where: { reservationId: deniedReservation.id }
    }))).resolves.toBe(0);
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

async function markMessageSent(reservationId: string, messageId: string): Promise<void> {
  await withSystemDatabaseContext((transaction) => transaction.discordReservationMessage.update({
    data: { channelId: "channel", guildId: "guild", initialSendStatus: "SENT", messageId, syncStatus: "SYNCED" },
    where: { reservationId }
  }));
}

function decisionCommand<const TKind extends "accept" | "reject">(input: {
  readonly interactionId: string;
  readonly kind: TKind;
  readonly reservationId: string;
  readonly sourceMessageId: string;
  readonly studentNumber: string;
}) {
  return { discordActorId: "discord-actor", interactionToken: "ephemeral-token", ...input } as const;
}
