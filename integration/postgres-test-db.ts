import type { Prisma, User } from "@prisma/client";

import { prisma } from "@/lib/db";
import { withDatabaseContext } from "@/lib/db-context";
import type { DatabaseActor } from "@/lib/db-context";

export { prisma };

export async function resetPostgresTestDatabase(): Promise<void> {
  await withSystemDatabaseContext(async (transaction) => {
    await transaction.discordInteractionReceipt.deleteMany();
    await transaction.discordReservationMessage.deleteMany();
    await transaction.auditLog.deleteMany();
    await transaction.userSanction.deleteMany();
    await transaction.adminAction.deleteMany();
    await transaction.reservation.deleteMany();
    await transaction.csrfToken.deleteMany();
    await transaction.session.deleteMany();
    await transaction.notificationDelivery.deleteMany();
    await transaction.operationalJob.deleteMany();
    await transaction.notificationSetting.deleteMany();
    await transaction.retentionPolicy.deleteMany();
    await transaction.periodSetting.deleteMany();
    await transaction.rateLimitBucket.deleteMany();
    await transaction.user.deleteMany();
  });
}

export async function seedUser(input: {
  readonly createdAt?: Date;
  readonly id: string;
  readonly role?: "ADMIN" | "STUDENT";
}): Promise<User> {
  return withSystemDatabaseContext((transaction) =>
    transaction.user.create({
      data: {
        bookingStatus: "ACTIVE",
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        generation: 32,
        id: input.id,
        name: input.role === "ADMIN" ? "통합 관리자" : "통합 학생",
        riroId: `riro-${input.id}`,
        role: input.role ?? "STUDENT",
        studentNumber: `test-${input.id}`
      }
    })
  );
}

export function withSystemDatabaseContext<TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withTestDatabaseContext({ id: null, role: "SYSTEM" }, operation);
}

export function withAdminDatabaseContext<TResult>(
  adminId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withTestDatabaseContext({ id: adminId, role: "ADMIN" }, operation);
}

export function withStudentDatabaseContext<TResult>(
  studentId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withTestDatabaseContext({ id: studentId, role: "STUDENT" }, operation);
}

function withTestDatabaseContext<TResult>(
  actor: DatabaseActor,
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> {
  return withDatabaseContext({ actor, client: prisma, operation });
}
