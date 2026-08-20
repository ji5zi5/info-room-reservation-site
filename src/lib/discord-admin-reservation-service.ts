import { bulkCancelAdministratorReservations } from "./admin-bulk-cancellation";
import { createAdministratorReservation } from "./admin-reservation-create-service";
import { cancelAdministratorReservation } from "./admin-reservation-operations";
import { prisma } from "./db";
import { withDatabaseContext } from "./db-context";
import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminIntent } from "./discord-admin-intents";

type ReservationIntent = Extract<DiscordAdminIntent, { readonly kind: `reservation_${string}` }>;

export type DiscordAdminReservationResult =
  | { readonly kind: "created"; readonly reservationId: string; readonly studentName: string }
  | { readonly kind: "cancelled"; readonly reservationId: string }
  | { readonly cancelled: number; readonly conflicts: number; readonly invalid: number; readonly kind: "bulk_cancelled"; readonly total: number }
  | { readonly code: string; readonly kind: "noop" };

export async function executeDiscordAdminReservationIntent(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: ReservationIntent;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordAdminReservationResult> {
  switch (input.intent.kind) {
    case "reservation_create": {
      const result = await createAdministratorReservation({
        actor: input.actor,
        date: input.intent.date,
        ipHash: input.ipHash,
        now: input.now,
        reason: input.intent.reservationReason,
        studentNumber: input.intent.studentNumber,
        studyPeriod: input.intent.studyPeriod
      });
      return result.kind === "confirmed"
        ? { kind: "created", reservationId: result.reservation.id, studentName: result.studentName }
        : { code: result.kind, kind: "noop" };
    }
    case "reservation_cancel": {
      const reservationId = await findReservationId(input.actor, input.intent);
      if (reservationId === null) return { code: "not_found", kind: "noop" };
      const result = await cancelAdministratorReservation({
        actor: input.actor,
        ipHash: input.ipHash,
        reason: input.intent.reason,
        reservationId,
        source: { kind: "DISCORD_ADMIN_COMMAND" }
      });
      return result.kind === "ok"
        ? { kind: "cancelled", reservationId: result.reservation.id }
        : { code: result.kind, kind: "noop" };
    }
    case "reservation_bulk_cancel": {
      const reservationIds = await withDatabaseContext({
        actor: input.actor,
        client: prisma,
        operation: (transaction) => transaction.reservation.findMany({
          select: { id: true },
          where: { date: input.intent.date, status: "CONFIRMED", studyPeriod: input.intent.studyPeriod }
        }).then((rows) => rows.map((row) => row.id))
      });
      const result = await bulkCancelAdministratorReservations({
        actor: input.actor,
        ipHash: input.ipHash,
        mode: "execute",
        reason: input.intent.reason,
        reservationIds,
        source: { kind: "DISCORD_ADMIN_COMMAND" }
      });
      return {
        cancelled: result.summary.cancelled,
        conflicts: result.summary.conflict,
        invalid: result.summary.invalidStatus + result.summary.notFound,
        kind: "bulk_cancelled",
        total: result.summary.total
      };
    }
    default:
      return assertNever(input.intent);
  }
}

function findReservationId(
  actor: DiscordAuthorizedAdmin,
  intent: Extract<ReservationIntent, { readonly kind: "reservation_cancel" }>
): Promise<string | null> {
  return withDatabaseContext({
    actor,
    client: prisma,
    operation: async (transaction) => {
      const user = await transaction.user.findUnique({ select: { id: true }, where: { studentNumber: intent.studentNumber } });
      if (user === null) return null;
      return (await transaction.reservation.findUnique({
        select: { id: true },
        where: { userId_date_studyPeriod: { date: intent.date, studyPeriod: intent.studyPeriod, userId: user.id } }
      }))?.id ?? null;
    }
  });
}

function assertNever(value: never): never {
  throw new DiscordAdminReservationVariantError(JSON.stringify(value));
}

class DiscordAdminReservationVariantError extends Error {
  public override readonly name = "DiscordAdminReservationVariantError";
}
