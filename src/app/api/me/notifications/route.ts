import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { databaseActorFromSessionUser, withDatabaseContext } from "@/lib/db-context";
import { jsonError } from "@/lib/http";
import { isNoDatabaseMockMode } from "@/lib/mock-dev-mode";
import { buildStudentNotifications, STUDENT_NOTIFICATION_ACTIONS } from "@/lib/student-notifications";
import { requireUser, UnauthorizedSessionError } from "@/lib/session";

export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    if (user.role === "ADMIN") {
      return jsonError(403, "forbidden", "Student notifications are not available to administrators.");
    }
    if (isNoDatabaseMockMode()) {
      return NextResponse.json({ notifications: [] });
    }

    const rows = await withDatabaseContext({
      actor: databaseActorFromSessionUser(user),
      client: prisma,
      operation: (transaction) =>
        transaction.adminAction.findMany({
          orderBy: { createdAt: "desc" },
          select: {
            action: true,
            createdAt: true,
            id: true,
            reason: true,
            reservation: { select: { date: true, studyPeriod: true } }
          },
          take: 5,
          where: { action: { in: [...STUDENT_NOTIFICATION_ACTIONS] }, targetUserId: user.id }
        })
    });
    return NextResponse.json({ notifications: buildStudentNotifications(rows) });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    throw error;
  }
}
