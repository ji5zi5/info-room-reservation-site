import { NextResponse } from "next/server";

import { getPrismaReadinessReport } from "@/lib/prisma-readiness";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const report = await getPrismaReadinessReport();
  const response = NextResponse.json(report, { status: report.status === "unready" ? 503 : 200 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
