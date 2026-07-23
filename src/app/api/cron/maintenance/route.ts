import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { jsonError } from "@/lib/http";
import { runMaintenanceCleanup } from "@/lib/maintenance-service";
import { runOperationalJob } from "@/lib/operational-job-runner";
import { prismaMaintenanceCleanupStore } from "@/lib/prisma-maintenance-store";
import { prismaOperationalJobStore } from "@/lib/prisma-operational-job-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.MAINTENANCE_CRON_SECRET)) {
    return jsonError(401, "unauthorized", "크론 인증이 필요합니다.");
  }

  const now = new Date();
  const run = await runOperationalJob({
    job: "MAINTENANCE",
    now,
    operation: async () => {
      const value = {
        cleanup: await runMaintenanceCleanup({ now, store: prismaMaintenanceCleanupStore })
      };
      return {
        backlogCount: 0,
        kind: "succeeded" as const,
        oldestBacklogAt: null,
        result: value,
        value
      };
    },
    store: prismaOperationalJobStore
  });
  if (run.kind === "already_running") {
    return NextResponse.json({ status: "already_running" }, { status: 202 });
  }
  if (run.kind === "failed") {
    return jsonError(500, "server_error", "유지보수 크론 실행에 실패했습니다.");
  }
  return NextResponse.json(run.value);
}
