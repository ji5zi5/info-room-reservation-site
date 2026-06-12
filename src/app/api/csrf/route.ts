import { NextResponse } from "next/server";

import { mintCsrfToken } from "@/lib/csrf";
import { jsonError } from "@/lib/http";
import { prismaCsrfTokenStore } from "@/lib/prisma-csrf-store";
import { getCurrentSession } from "@/lib/session";

export async function GET(): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return jsonError(401, "unauthorized", "로그인이 필요합니다.");
  }

  return NextResponse.json({
    csrfToken: await mintCsrfToken({ now: new Date(), sessionId: session.id, store: prismaCsrfTokenStore })
  });
}
