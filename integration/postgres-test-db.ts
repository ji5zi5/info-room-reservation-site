import type { User } from "@prisma/client";

import { prisma } from "@/lib/db";

export { prisma };

export async function resetPostgresTestDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.userSanction.deleteMany(),
    prisma.adminAction.deleteMany(),
    prisma.reservation.deleteMany(),
    prisma.csrfToken.deleteMany(),
    prisma.session.deleteMany(),
    prisma.notificationDelivery.deleteMany(),
    prisma.operationalJob.deleteMany(),
    prisma.notificationSetting.deleteMany(),
    prisma.retentionPolicy.deleteMany(),
    prisma.periodSetting.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.user.deleteMany()
  ]);
}

export async function seedUser(input: {
  readonly id: string;
  readonly role?: "ADMIN" | "STUDENT";
}): Promise<User> {
  return prisma.user.create({
    data: {
      bookingStatus: "ACTIVE",
      generation: 32,
      id: input.id,
      name: input.role === "ADMIN" ? "통합 관리자" : "통합 학생",
      riroId: `riro-${input.id}`,
      role: input.role ?? "STUDENT",
      studentNumber: `test-${input.id}`
    }
  });
}
