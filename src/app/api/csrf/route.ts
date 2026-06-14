import { NextResponse } from "next/server";

import { mintCsrfToken } from "@/lib/csrf";
import { getCsrfTokenStore } from "@/lib/csrf-token-store";
import { jsonError } from "@/lib/http";
import { getCurrentSession } from "@/lib/session";

export async function GET(): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return jsonError(401, "unauthorized", "로그인이 필요합니다.");
  }

  return NextResponse.json({
    csrfToken: await mintCsrfToken({ now: new Date(), sessionId: session.id, store: getCsrfTokenStore() })
  });
}
