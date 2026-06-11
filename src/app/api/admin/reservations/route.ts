import { NextResponse } from "next/server";

import { toKstDate } from "@/lib/date";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await requireAdmin();
    const date = new URL(request.url).searchParams.get("date") ?? toKstDate(new Date());
    const reservations = await prisma.reservation.findMany({
      include: { user: true },
      orderBy: [{ studyPeriod: "desc" }, { createdAt: "asc" }],
      where: { date }
    });
    return NextResponse.json({ reservations });
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof ForbiddenSessionError) {
      return jsonError(403, "forbidden", error.message);
    }
    throw error;
  }
}
