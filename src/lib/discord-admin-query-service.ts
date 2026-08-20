import { prisma } from "./db";
import { withDatabaseContext } from "./db-context";
import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminReadIntent } from "./discord-admin-intents";
import { getPeriodSummaries, type PeriodSummary } from "./period-settings";
import { getPrismaNotificationSettings } from "./prisma-notification-settings";

export type DiscordAdminReadResult =
  | { readonly date: string; readonly kind: "periods"; readonly periods: readonly PeriodSummary[] }
  | {
      readonly kind: "students";
      readonly students: readonly {
        readonly bookingStatus: string;
        readonly id: string;
        readonly name: string;
        readonly recentReservations: readonly { readonly date: string; readonly status: string; readonly studyPeriod: string }[];
        readonly restrictionReason: string | null;
        readonly restrictedUntil: Date | null;
        readonly shadowBanProfile: string;
        readonly studentNumber: string;
      }[];
    }
  | { readonly closedEnabled: boolean; readonly kind: "notification_settings"; readonly reservationEnabled: boolean }
  | {
      readonly adminCommandBacklog: number;
      readonly interactionBacklog: number;
      readonly kind: "operations";
      readonly operationalJobs: readonly { readonly job: string; readonly lastSuccessAt: Date | null; readonly status: string }[];
      readonly unresolvedDeliveries: number;
    };

export async function executeDiscordAdminReadIntent(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: DiscordAdminReadIntent;
  readonly now: Date;
}): Promise<DiscordAdminReadResult> {
  switch (input.intent.kind) {
    case "status":
    case "roster":
    case "settings_get":
      return {
        date: input.intent.date,
        kind: "periods",
        periods: await getPeriodSummaries(input.intent.date, { actor: input.actor, includeApplicants: true, now: input.now })
      };
    case "student_lookup":
      return { kind: "students", students: await findStudents(input.actor, input.intent.query) };
    case "notification_status": {
      const settings = await getPrismaNotificationSettings();
      return {
        closedEnabled: settings.closedPeriodNotificationsEnabled,
        kind: "notification_settings",
        reservationEnabled: settings.reservationCreatedNotificationsEnabled
      };
    }
    case "operations_status":
    case "operations_backlog":
      return readOperations(input.actor);
    default:
      return assertNever(input.intent);
  }
}

async function findStudents(actor: DiscordAuthorizedAdmin, query: string): Promise<Extract<DiscordAdminReadResult, { readonly kind: "students" }>['students']> {
  return withDatabaseContext({
    actor,
    client: prisma,
    operation: async (transaction) => {
      const users = await transaction.user.findMany({
        orderBy: [{ studentNumber: "asc" }],
        select: {
          bookingStatus: true,
          id: true,
          name: true,
          restrictionReason: true,
          restrictedUntil: true,
          shadowBanProfile: true,
          studentNumber: true
        },
        take: 10,
        where: {
          departedAt: null,
          role: "STUDENT",
          OR: [
            { studentNumber: { contains: query } },
            { name: { contains: query, mode: "insensitive" } }
          ]
        }
      });
      return Promise.all(users.map(async (user) => ({
        ...user,
        recentReservations: await transaction.reservation.findMany({
          orderBy: { createdAt: "desc" },
          select: { date: true, status: true, studyPeriod: true },
          take: 10,
          where: { userId: user.id }
        })
      })));
    }
  });
}

function readOperations(actor: DiscordAuthorizedAdmin): Promise<Extract<DiscordAdminReadResult, { readonly kind: "operations" }>> {
  return withDatabaseContext({
    actor,
    client: prisma,
    operation: async (transaction) => {
      const [adminCommandBacklog, interactionBacklog, unresolvedDeliveries, operationalJobs] = await Promise.all([
        transaction.discordAdminCommandJob.count({ where: { status: { in: ["PENDING", "PROCESSING", "RETRY"] } } }),
        transaction.discordInteractionJob.count({ where: { status: { in: ["PENDING", "PROCESSING", "RETRY"] } } }),
        transaction.notificationDelivery.count({ where: { status: { in: ["FAILED", "PENDING", "SENDING", "UNKNOWN"] } } }),
        transaction.operationalJob.findMany({
          orderBy: { job: "asc" },
          select: { job: true, lastSuccessAt: true, status: true }
        })
      ]);
      return { adminCommandBacklog, interactionBacklog, kind: "operations", operationalJobs, unresolvedDeliveries };
    }
  });
}

function assertNever(value: never): never {
  throw new DiscordAdminReadVariantError(JSON.stringify(value));
}

class DiscordAdminReadVariantError extends Error {
  public override readonly name = "DiscordAdminReadVariantError";
}
