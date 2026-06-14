import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { jsonError } from "@/lib/http";
import { runMaintenanceCleanup } from "@/lib/maintenance-service";
import { prismaMaintenanceCleanupStore } from "@/lib/prisma-maintenance-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return jsonError(401, "unauthorized", "크론 인증이 필요합니다.");
  }

  return NextResponse.json({
    cleanup: await runMaintenanceCleanup({
      now: new Date(),
      store: prismaMaintenanceCleanupStore
    })
  });
}
